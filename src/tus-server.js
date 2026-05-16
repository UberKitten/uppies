import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { TUS_TMP_DIR, SHARES_DIR, TUS_PATH } from './config.js';
import { getShare, shareStats, addFile } from './db.js';

class UploadError extends Error {
  constructor(status, body) {
    super(body);
    this.status_code = status;
    this.body = body;
  }
}

// Extract shareId from the Upload-Metadata header / upload.metadata.
function readShareId(upload) {
  return upload.metadata?.shareId || null;
}

function readFilename(upload) {
  const name = upload.metadata?.filename || upload.metadata?.name;
  if (!name) return 'unnamed';
  // Strip any path components — store original filename string only.
  return name.replace(/[\x00-\x1f]/g, '').split(/[/\\]/).pop() || 'unnamed';
}

export function createTusServer() {
  const datastore = new FileStore({ directory: TUS_TMP_DIR });

  const server = new Server({
    path: TUS_PATH,
    datastore,
    // Behind a TLS-terminating proxy (pomerium), use the forwarded scheme/host
    // when building the Location header sent back to clients.
    respectForwardedHeaders: true,

    async onUploadCreate(req, res, upload) {
      const shareId = readShareId(upload);
      if (!shareId) throw new UploadError(400, 'missing shareId metadata');

      const share = getShare(shareId);
      if (!share) throw new UploadError(404, 'share not found');

      const now = Date.now();
      if (share.expires_at && share.expires_at < now) {
        throw new UploadError(410, 'share has expired');
      }

      const stats = shareStats(shareId);
      if (stats.fileCount >= share.max_files) {
        throw new UploadError(409, 'share file count limit reached');
      }
      const declaredSize = typeof upload.size === 'number' ? upload.size : 0;
      if (stats.bytesUsed + declaredSize > share.max_size_bytes) {
        throw new UploadError(413, 'share size limit would be exceeded');
      }
      return res;
    },

    async onUploadFinish(req, res, upload) {
      const shareId = readShareId(upload);
      const share = shareId ? getShare(shareId) : null;
      if (!share) {
        // Clean up the orphan and reject.
        try { await datastore.remove(upload.id); } catch (e) {}
        throw new UploadError(404, 'share not found at finish');
      }

      const filename = readFilename(upload);
      const tmpPath = path.join(TUS_TMP_DIR, upload.id);
      const destDir = path.join(SHARES_DIR, shareId);
      const destPath = path.join(destDir, upload.id);

      await fsp.mkdir(destDir, { recursive: true });
      // Rename within the same filesystem; fall back to copy+unlink across mounts.
      try {
        await fsp.rename(tmpPath, destPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await fsp.copyFile(tmpPath, destPath);
          await fsp.unlink(tmpPath);
        } else {
          throw err;
        }
      }
      // Delete configstore sidecar.
      await fsp.unlink(tmpPath + '.json').catch(() => {});

      addFile({
        id: upload.id,
        shareId,
        filename,
        sizeBytes: upload.size,
        storagePath: path.relative(SHARES_DIR, destPath),
      });

      return {
        res,
        status_code: 204,
        headers: {},
        body: '',
      };
    },
  });

  return server;
}
