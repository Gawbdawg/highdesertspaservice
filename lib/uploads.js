// Saves a base64 data-URL (already resized client-side before upload) to disk
// and returns a URL path the browser can load it from. Files live under
// data/uploads so they follow the same persistence rules as data.json — see
// README for the note about Render's free tier resetting local disk on restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads', 'photos');

function ensureDir() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function savePhoto(dataUrl) {
  ensureDir();
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Invalid image data');
  const ext = match[1].split('/')[1].replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Image is too large (max 8MB)');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `/uploads/photos/${filename}`;
}

function deletePhoto(urlPath) {
  const filename = path.basename(urlPath || '');
  const filePath = path.join(UPLOADS_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { savePhoto, deletePhoto };
