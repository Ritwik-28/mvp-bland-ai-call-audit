/********************************************************************
 *  Lightweight Drive-index cache
 *  -----------------------------
 *  • init(rootId)         – build / refresh index, recurse folders
 *  • listPaths(prefix='') – return ALL paths, optionally filtered
 *  • getText(path)        – download a .txt once, then keep in RAM
 ********************************************************************/

import fs from 'fs';
import path from 'path';
import { drive } from '../auth.js';
import { logger } from './logger.js';

const CACHE_DIR  = '.cache';
const INDEX_FILE = path.join(CACHE_DIR, 'drive_index.json');

let index = {};         // { "Prompt/General/foo.txt": { id, mtime } }
let textCache = {};     // in-memory { path → file text }

/* ─────────────────────────────────────────────────────────────────── */

export async function init(rootFolderId) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // load existing index if present
  if (fs.existsSync(INDEX_FILE)) {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  }

  // quick freshness check (cheap)
  const { data } = await drive.files.list({
    q: `'${rootFolderId}' in parents and trashed = false`,
    fields: 'files(id,name,modifiedTime,mimeType)'
  });

  let stale = false;
  for (const f of data.files) {
    const cached = index[f.name];
    if (!cached || cached.mtime !== f.modifiedTime) { stale = true; break; }
  }
  if (!stale) { logger.debug('Drive index cache is fresh'); return; }

  // full rebuild
  logger.info('Rebuilding Drive index cache …');
  index = {};
  await walk(rootFolderId, '');
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  logger.info(`Drive index rebuilt – ${Object.keys(index).length} .txt files`);
}

/* helper: recurse */
async function walk(folderId, prefix) {
  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)'
  });

  for (const f of data.files) {
    const rel = prefix ? `${prefix}/${f.name}` : f.name;
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      await walk(f.id, rel);
    } else if (f.name.endsWith('.txt')) {
      index[rel] = { id: f.id, mtime: f.modifiedTime };
    }
  }
}

/* ─────────────────────────────────────────────────────────────────── */

export function listPaths(prefix = '') {
  return Object.keys(index).filter(p => p.startsWith(prefix));
}

export async function getText(relPath) {
  if (textCache[relPath]) return textCache[relPath];
  const meta = index[relPath];
  if (!meta) return '';

  const { data } = await drive.files.get(
    { fileId: meta.id, alt: 'media' },
    { responseType: 'text' }
  );
  textCache[relPath] = data;
  return data;
}