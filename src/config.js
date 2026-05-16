import path from 'node:path';

export const STORAGE_DIR = process.env.UPPIES_STORAGE_DIR || '/data';
export const DB_PATH = path.join(STORAGE_DIR, 'db.sqlite');
export const SHARES_DIR = path.join(STORAGE_DIR, 'shares');
export const TUS_TMP_DIR = path.join(STORAGE_DIR, 'tmp');

export const PORT = Number(process.env.UPPIES_PORT) || 3000;
export const HOST = process.env.UPPIES_HOST || '0.0.0.0';
export const PUBLIC_URL = (process.env.UPPIES_PUBLIC_URL || '').replace(/\/+$/, '');

export const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 10000;

export const TUS_PATH = '/api/tus';
export const RESERVED_PREFIXES = new Set([
  'api', 'static', 'favicon.ico', 'robots.txt', 'health', '_health',
]);
