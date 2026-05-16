import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createTusServer } from './tus-server.js';
import { getShare, listFiles, getFile, shareStats } from './db.js';
import { SHARES_DIR, PORT, HOST, TUS_PATH, RESERVED_PREFIXES } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend', 'dist');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// RFC 5987 / 6266 — quote ASCII filename and provide UTF-8 fallback.
function contentDispositionAttachment(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8}`;
}

function loadTemplate() {
  const p = path.join(FRONTEND_DIR, 'index.html');
  if (!fs.existsSync(p)) {
    throw new Error(`frontend not built: ${p} missing. Run npm run build:frontend.`);
  }
  return fs.readFileSync(p, 'utf8');
}

export async function buildServer({ logger = true } = {}) {
  // The tus content-type parser is a no-op so bodyLimit shouldn't apply to
  // PATCH bodies — but make it generous anyway in case Fastify counts bytes
  // before the parser fires.
  const app = Fastify({ logger, bodyLimit: 10 * 1024 * 1024 * 1024 });
  const tusServer = createTusServer();
  const indexTemplate = loadTemplate();

  // tus uses `application/offset+octet-stream` for PATCH bodies and sometimes
  // omits content-type entirely. We hand the raw stream to @tus/server, so
  // register no-op parsers that don't touch the body.
  const noopParser = (_req, _payload, done) => done(null);
  app.addContentTypeParser('application/offset+octet-stream', noopParser);
  app.addContentTypeParser('*', noopParser);

  // tus protocol endpoints — hand the raw req/res over to @tus/server.
  // Match exactly TUS_PATH and any sub-path.
  const tusHandler = async (req, reply) => {
    reply.hijack();
    try {
      await tusServer.handle(req.raw, reply.raw);
    } catch (err) {
      req.log.error(err, 'tus error');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end('tus error');
      }
    }
  };
  app.all(TUS_PATH, tusHandler);
  app.all(TUS_PATH + '/*', tusHandler);

  // Static frontend assets — bundled JS + CSS.
  app.register(fastifyStatic, {
    root: FRONTEND_DIR,
    prefix: '/static/',
    decorateReply: false,
    serve: true,
  });

  app.get('/', async (_req, reply) => {
    reply.code(404).type('text/plain').send('Not found.\n');
  });

  app.get('/health', async () => ({ ok: true }));

  // Share page — server-side render title with share name.
  app.get('/:shareId', async (req, reply) => {
    const { shareId } = req.params;
    if (!isValidShareId(shareId)) {
      return reply.code(404).type('text/plain').send('Not found.\n');
    }
    const share = getShare(shareId);
    if (!share) {
      return reply.code(404).type('text/plain').send('Not found.\n');
    }
    const html = indexTemplate
      .replace(/\{\{shareName\}\}/g, escapeHtml(share.name))
      .replace(/\{\{shareId\}\}/g, escapeHtml(share.id));
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(html);
  });

  // File list (JSON) — used by the frontend to render the file table.
  app.get('/:shareId/files', async (req, reply) => {
    const { shareId } = req.params;
    if (!isValidShareId(shareId)) return reply.code(404).send({ error: 'not found' });
    const share = getShare(shareId);
    if (!share) return reply.code(404).send({ error: 'not found' });
    const files = listFiles(shareId).map((f) => ({
      id: f.id,
      name: f.filename,
      size_bytes: f.sizeBytes,
      uploaded_at: f.uploadedAt,
    }));
    const stats = shareStats(shareId);
    return {
      share: {
        id: share.id,
        name: share.name,
        max_size_bytes: share.max_size_bytes,
        max_files: share.max_files,
        expires_at: share.expires_at,
        created_at: share.created_at,
        bytes_used: stats.bytesUsed,
        file_count: stats.fileCount,
      },
      files,
    };
  });

  // File download — stream from disk.
  app.get('/:shareId/files/:fileId', async (req, reply) => {
    const { shareId, fileId } = req.params;
    if (!isValidShareId(shareId)) return reply.code(404).send('not found');
    const file = getFile(shareId, fileId);
    if (!file) return reply.code(404).send('not found');

    const fullPath = path.join(SHARES_DIR, file.storagePath);
    // Guard against any path-traversal in storagePath (shouldn't happen but cheap to verify).
    const sharesRoot = path.resolve(SHARES_DIR);
    if (!path.resolve(fullPath).startsWith(sharesRoot + path.sep)) {
      return reply.code(404).send('not found');
    }
    if (!fs.existsSync(fullPath)) {
      return reply.code(404).send('file missing on disk');
    }

    const stat = fs.statSync(fullPath);
    reply
      .type('application/octet-stream')
      .header('content-length', stat.size)
      .header('content-disposition', contentDispositionAttachment(file.filename))
      .header('cache-control', 'no-store');
    return reply.send(fs.createReadStream(fullPath));
  });

  return app;
}

function isValidShareId(id) {
  if (typeof id !== 'string') return false;
  if (id.length < 8 || id.length > 128) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
  if (RESERVED_PREFIXES.has(id.toLowerCase())) return false;
  return true;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`uppies listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
