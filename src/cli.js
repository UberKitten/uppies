import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Command, Option } from 'commander';
import {
  createShare,
  getShare,
  listShares,
  updateShareExpiry,
  deleteShare,
  shareStats,
  listFiles,
} from './db.js';
import { SHARES_DIR, PUBLIC_URL, DEFAULT_MAX_SIZE_BYTES, DEFAULT_MAX_FILES } from './config.js';

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$/i;
function parseSize(s) {
  if (s == null) return null;
  const m = String(s).trim().match(SIZE_RE);
  if (!m) throw new Error(`invalid size: ${s}. Use values like "100GB", "500MB", "1TB".`);
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase().replace(/B$/, '');
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit];
  return Math.round(n * mult);
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

function parseExpiresAt(s) {
  if (s == null) return undefined;
  if (s === '') return null; // explicit clear
  // YYYY-MM-DD — interpreted as UTC end-of-day so the share lasts through that date.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
    return ts;
  }
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) throw new Error(`invalid expiry date: ${s} (use YYYY-MM-DD)`);
  return ts;
}

function shareUrl(id) {
  if (PUBLIC_URL) return `${PUBLIC_URL}/${id}`;
  return `/${id}`;
}

function formatExpires(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  const now = Date.now();
  const diffDays = Math.round((ts - now) / 86400000);
  return `${d.toISOString()} (${diffDays >= 0 ? `in ${diffDays}d` : `${-diffDays}d ago`})`;
}

const program = new Command();
program.name('uppies').description('Manage uppies shares from the CLI.');

const share = program.command('share').description('Manage shares');

share
  .command('create')
  .description('Create a new share')
  .argument('<name>', 'Human label shown on the share page')
  .option('--max-size <size>', 'Max total bytes (e.g. 100GB, 500MB, 1TB)')
  .option('--max-files <n>', 'Max file count', (v) => parseInt(v, 10))
  .option('--expires <date>', 'Expiry date (YYYY-MM-DD)')
  .action((name, opts) => {
    const maxSizeBytes = opts.maxSize ? parseSize(opts.maxSize) : DEFAULT_MAX_SIZE_BYTES;
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const expiresAt = parseExpiresAt(opts.expires);
    const created = createShare({ name, maxSizeBytes, maxFiles, expiresAt: expiresAt ?? null });
    console.log(`share ${created.id}`);
    console.log(`  name      ${created.name}`);
    console.log(`  max-size  ${formatBytes(created.max_size_bytes)} (${created.max_size_bytes} bytes)`);
    console.log(`  max-files ${created.max_files}`);
    console.log(`  expires   ${formatExpires(created.expires_at)}`);
    console.log('');
    console.log(`  url       ${shareUrl(created.id)}`);
  });

share
  .command('list')
  .description('List all shares')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const shares = listShares().map((s) => {
      const st = shareStats(s.id);
      return { ...s, bytes_used: st.bytesUsed, file_count: st.fileCount };
    });
    if (opts.json) {
      console.log(JSON.stringify(shares, null, 2));
      return;
    }
    if (shares.length === 0) {
      console.log('(no shares)');
      return;
    }
    for (const s of shares) {
      console.log(`${s.id}  ${s.name}`);
      console.log(
        `  ${s.file_count}/${s.max_files} files · ${formatBytes(s.bytes_used)} / ${formatBytes(s.max_size_bytes)} · expires ${formatExpires(s.expires_at)}`,
      );
      console.log(`  ${shareUrl(s.id)}`);
      console.log('');
    }
  });

share
  .command('show')
  .description('Show details for a share')
  .argument('<id>', 'Share ID')
  .action((id) => {
    const s = getShare(id);
    if (!s) {
      console.error(`share not found: ${id}`);
      process.exit(1);
    }
    const stats = shareStats(id);
    const storage = path.join(SHARES_DIR, id);
    console.log(`share ${s.id}`);
    console.log(`  name      ${s.name}`);
    console.log(`  files     ${stats.fileCount} / ${s.max_files}`);
    console.log(`  size      ${formatBytes(stats.bytesUsed)} / ${formatBytes(s.max_size_bytes)}`);
    console.log(`  expires   ${formatExpires(s.expires_at)}`);
    console.log(`  created   ${new Date(s.created_at).toISOString()}`);
    console.log(`  storage   ${storage}`);
    console.log(`  url       ${shareUrl(s.id)}`);
  });

share
  .command('delete')
  .description('Delete a share AND its files on disk')
  .argument('<id>', 'Share ID')
  .option('--force', 'Skip confirmation prompt')
  .action(async (id, opts) => {
    const s = getShare(id);
    if (!s) {
      console.error(`share not found: ${id}`);
      process.exit(1);
    }
    const stats = shareStats(id);
    if (!opts.force) {
      console.log(`About to delete share ${id} (${s.name})`);
      console.log(`  ${stats.fileCount} files, ${formatBytes(stats.bytesUsed)}`);
      console.log(`  storage: ${path.join(SHARES_DIR, id)}`);
      const answer = await prompt('Type the share id to confirm: ');
      if (answer.trim() !== id) {
        console.error('Mismatch — aborted.');
        process.exit(1);
      }
    }
    deleteShare(id);
    const dir = path.join(SHARES_DIR, id);
    await fsp.rm(dir, { recursive: true, force: true });
    console.log(`deleted share ${id}`);
  });

share
  .command('extend')
  .description('Update a share\'s expiry')
  .argument('<id>', 'Share ID')
  .requiredOption('--expires <date>', 'New expiry date (YYYY-MM-DD), or "" to clear')
  .action((id, opts) => {
    const s = getShare(id);
    if (!s) {
      console.error(`share not found: ${id}`);
      process.exit(1);
    }
    const expiresAt = parseExpiresAt(opts.expires);
    updateShareExpiry(id, expiresAt);
    const after = getShare(id);
    console.log(`share ${id}`);
    console.log(`  expires   ${formatExpires(after.expires_at)}`);
  });

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(buf.slice(0, idx));
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
