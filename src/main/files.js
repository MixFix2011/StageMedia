'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const { pathToFileURL } = require('url');


const EXT = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  video: ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv'] // Добавили видеоформаты
};
// Форматы, которые 100% не заведутся без конвертации
const BAD_EXTS = ['.mkv', '.avi', '.wmv', '.flv'];

const kindOf = e => EXT.image.includes(e) ? 'image' : EXT.video.includes(e) ? 'video' : null;
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' }); // "2.jpg" < "10.jpg"

const makeItem = (p, size) => {
  const ext = path.extname(p).toLowerCase();
  let err = null;
  if (BAD_EXTS.includes(ext)) {
    err = 'Формат ' + ext + ' не поддерживается. Конвертируйте в MP4.';
  }
  return {
    id: crypto.randomUUID(), path: p, dir: path.dirname(p), name: path.basename(p), ext, kind: kindOf(ext),
    size, url: pathToFileURL(p).href, missing: false, error: err
  };
};

// Рекурсивно собирает поддерживаемые файлы из файлов/папок
async function collect(p, out, depth = 0) {
  let st; try { st = await fs.promises.stat(p); } catch { return; }
  if (st.isDirectory()) {
    if (depth > 8) return;
    let names = []; try { names = await fs.promises.readdir(p); } catch { return; }
    for (const n of names.sort(collator.compare)) await collect(path.join(p, n), out, depth + 1);
  } else if (kindOf(path.extname(p).toLowerCase())) out.push(makeItem(p, st.size));
}
async function resolvePaths(paths) { const out = []; for (const p of paths || []) await collect(p, out); return out; }
const exists = p => fs.promises.access(p, fs.constants.R_OK).then(() => true, () => false);

// Миниатюры: системные (работают и для видео), с кэшем в памяти
const thumbCache = new Map();
async function thumb(p, size = 240) {
  const key = p + '|' + size;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let img = null;
  try { img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size }); } catch { }
  if ((!img || img.isEmpty()) && kindOf(path.extname(p).toLowerCase()) === 'image') {
    try { const i = nativeImage.createFromPath(p); if (!i.isEmpty()) img = i.resize({ width: size }); } catch { }
  }
  const url = img && !img.isEmpty() ? 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64') : null;
  if (thumbCache.size > 1500) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(key, url);
  return url;
}
async function readDir(dirPath) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = [];
    let parent = path.dirname(dirPath);
    if (parent === dirPath) parent = null;

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: fullPath, name: entry.name, isDirectory: true });
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const kind = kindOf(ext);
        if (kind) {
          result.push({ path: fullPath, name: entry.name, isDirectory: false, kind, ext });
        }
      }
    }
    const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return collator.compare(a.name, b.name);
    });
    return { path: dirPath, parent, entries: result };
  } catch (e) {
    return { path: dirPath, parent: null, entries: [], error: e.message };
  }
}

async function searchFiles(dirPath, query) {
  const results = [];
  const q = query.toLowerCase();

  async function scan(currentPath, depth) {
    if (depth > 5) return; // Ограничиваем глубину, чтобы не завис компьютер
    try {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath, depth + 1);
        } else if (kindOf(path.extname(entry.name).toLowerCase())) {
          if (entry.name.toLowerCase().includes(q)) {
            results.push({ path: fullPath, name: entry.name, isDirectory: false, kind: kindOf(path.extname(entry.name).toLowerCase()) });
          }
        }
      }
    } catch (e) { }
  }

  await scan(dirPath, 0);
  return results;
}

module.exports = { resolvePaths, exists, thumb, readDir, searchFiles, EXT };