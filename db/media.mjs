import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import db from './init.mjs';

const MEDIA_DIR = path.join(process.cwd(), 'data', 'media');
await fs.mkdir(MEDIA_DIR, { recursive: true });

export async function saveMedia(buffer, originalName = 'media.png', mimeType = 'image/png') {
  const id = crypto.randomUUID();
  const ext = path.extname(originalName) || '';
  const fileName = `${id}${ext}`;
  const filePath = path.join(MEDIA_DIR, fileName);
  await fs.writeFile(filePath, buffer);

  db.prepare(`
    INSERT INTO media_assets (id, file_path, mime_type, file_name, size_bytes)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, fileName, mimeType, buffer.length);

  return id;
}

export function getMediaAsset(id) {
  return db.prepare(`SELECT * FROM media_assets WHERE id = ?`).get(id);
}
