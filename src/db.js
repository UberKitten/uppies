import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, STORAGE_DIR, SHARES_DIR, TUS_TMP_DIR, RESERVED_PREFIXES } from './config.js';

function ensureDirs() {
  for (const d of [STORAGE_DIR, SHARES_DIR, TUS_TMP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

let _db = null;

export function getDb() {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_size_bytes INTEGER NOT NULL,
      max_files INTEGER NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL,
      storage_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS files_share_id_uploaded_at
      ON files(share_id, uploaded_at DESC);
  `);
  return _db;
}

// urlsafe alphabet: A-Z a-z 0-9 - _
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function generateShareId(length = 24) {
  while (true) {
    const bytes = crypto.randomBytes(length);
    let id = '';
    for (let i = 0; i < length; i++) {
      id += ALPHABET[bytes[i] % ALPHABET.length];
    }
    if (RESERVED_PREFIXES.has(id)) continue;
    // Belt + suspenders: also reject IDs that *equal* a reserved name even with different casing
    if (RESERVED_PREFIXES.has(id.toLowerCase())) continue;
    return id;
  }
}

export function createShare({ name, maxSizeBytes, maxFiles, expiresAt }) {
  const db = getDb();
  const id = generateShareId();
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO shares (id, name, max_size_bytes, max_files, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, maxSizeBytes, maxFiles, expiresAt ?? null, createdAt);
  fs.mkdirSync(path.join(SHARES_DIR, id), { recursive: true });
  return getShare(id);
}

export function getShare(id) {
  return getDb().prepare('SELECT * FROM shares WHERE id = ?').get(id) || null;
}

export function listShares() {
  return getDb().prepare('SELECT * FROM shares ORDER BY created_at DESC').all();
}

export function updateShareExpiry(id, expiresAt) {
  const r = getDb()
    .prepare('UPDATE shares SET expires_at = ? WHERE id = ?')
    .run(expiresAt ?? null, id);
  return r.changes > 0;
}

export function deleteShare(id) {
  const db = getDb();
  // Files are cascade-deleted by FK. Storage cleanup is the caller's job.
  const r = db.prepare('DELETE FROM shares WHERE id = ?').run(id);
  return r.changes > 0;
}

export function shareStats(id) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS bytes_used
    FROM files WHERE share_id = ?
  `).get(id);
  return { fileCount: row.file_count, bytesUsed: row.bytes_used };
}

export function addFile({ id, shareId, filename, sizeBytes, storagePath }) {
  const uploadedAt = Date.now();
  getDb().prepare(`
    INSERT INTO files (id, share_id, filename, size_bytes, uploaded_at, storage_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, shareId, filename, sizeBytes, uploadedAt, storagePath);
  return { id, shareId, filename, sizeBytes, uploadedAt, storagePath };
}

export function listFiles(shareId) {
  return getDb().prepare(`
    SELECT id, filename, size_bytes AS sizeBytes, uploaded_at AS uploadedAt, storage_path AS storagePath
    FROM files WHERE share_id = ?
    ORDER BY uploaded_at DESC
  `).all(shareId);
}

export function getFile(shareId, fileId) {
  return getDb().prepare(`
    SELECT id, share_id AS shareId, filename, size_bytes AS sizeBytes,
           uploaded_at AS uploadedAt, storage_path AS storagePath
    FROM files WHERE share_id = ? AND id = ?
  `).get(shareId, fileId) || null;
}
