import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('.', import.meta.url));
const password = process.env.ADMIN_PASSWORD ?? '';
const phone = process.env.SHOP_WHATSAPP ?? '';
if (password.length < 12) throw new Error('Set ADMIN_PASSWORD to at least 12 characters in .env.');
if (phone && !/^[1-9]\d{6,14}$/.test(phone)) throw new Error('Use the WhatsApp country code and number, digits only.');
const digest = value => createHash('sha256').update(value).digest();
const passwordDigest = digest(password);
const dataDir = process.env.DATA_DIR || join(root, 'data');
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'shop.sqlite'));
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
    price INTEGER NOT NULL, mime TEXT NOT NULL, photo BLOB NOT NULL
  )`);
const list = db.prepare('SELECT id, name, category, price FROM products ORDER BY id DESC');
const add = db.prepare('INSERT INTO products (name, category, price, mime, photo) VALUES (?, ?, ?, ?, ?)');
const photo = db.prepare('SELECT mime, photo FROM products WHERE id = ?');

const samples = [
  ['Sculpted Gold Hoops','Jewellery',649,'hoops.webp'],
  ['Velvet Bow Barrette','Accessories',349,'bow.webp'],
  ['Classic Pearl Bracelet','Jewellery',599,'pearls.webp'],
  ['Mini Quilted Bag','Accessories',1499,'bag.webp'],
  ['Botanical Silk Scarf','Accessories',799,'scarf.webp'],
  ['Signature Gift Box','Gifts',1299,'gift.webp'],
].map(([name,category,price,image], i) => ({ id: 'IE-0' + (i+1), name, category, price, image }));

const sessions = new Map();
const attempts = new Map();
const sessionLifetime = 8 * 60 * 60 * 1000;
const windowMs = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
  for (const [key, entry] of attempts) if (entry.expires <= now) attempts.delete(key);
}, 60_000).unref();
const secure = process.env.SECURE_COOKIES === 'true' ? '; Secure' : '';
const cookie = (value, seconds) => `ivory_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
const tokenFrom = request => /(?:^|;\s*)ivory_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
const signedIn = request => (sessions.get(tokenFrom(request)) ?? 0) > Date.now();
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(request, limit) {
  if (request.headers['content-type'] !== 'application/json' || request.headers['sec-fetch-site'] === 'cross-site') {
    throw fail(415, 'Expected a same-site JSON request.');
  }
  if (Number(request.headers['content-length']) > limit) throw fail(413, 'The upload is too large.');
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) oversized = true;
    if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw fail(413, 'The upload is too large.');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); }
  catch { throw fail(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Expected a JSON object.');
  return body;
}

function imageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const files = new Set(['index.html','style.css','shop.js','admin.html','admin.js', ...samples.map(p => p.image), 'hero.webp']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp' };

async function route(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET') {
    if (path === '/api/products') {
      const products = list.all().map(p => ({ ...p, id: 'IE-P' + p.id, image: '/photos/' + p.id }));
      return json(res, 200, { products: [...products, ...(process.env.SHOW_SAMPLE_PRODUCTS === 'false' ? [] : samples)], shopWhatsApp: phone });
    }
    if (path === '/api/admin/session') return json(res, 200, { signedIn: signedIn(req) });
    const photoId = /^\/photos\/([1-9]\d{0,14})$/.exec(path);
    if (photoId) {
      const row = photo.get(Number(photoId[1]));
      if (!row) throw fail(404, 'Photo not found.');
      res.writeHead(200, { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=86400' });
      return res.end(row.photo);
    }
    const file = path === '/' ? 'index.html' : path === '/admin' ? 'admin.html' : path.slice(1);
    if (!files.has(file)) throw fail(404, 'Page not found.');
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-cache' });
    return res.end(await readFile(join(root,'public',file)));
  }

  if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
  if (path === '/api/admin/login') {
    const body = await readJson(req, 4096);
    const key = req.socket.remoteAddress;
    const now = Date.now();
    const prior = attempts.get(key);
    const entry = prior?.expires > now ? prior : { count: 0, expires: now + windowMs };
    if (entry.count >= 10) throw fail(429, 'Too many attempts. Try again in 15 minutes.');
    if (typeof body.password !== 'string' || !timingSafeEqual(digest(body.password), passwordDigest)) {
      entry.count++;
      attempts.set(key, entry);
      throw fail(401, 'Incorrect password.');
    }
    attempts.delete(key);
    sessions.delete(tokenFrom(req));
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + sessionLifetime);
    res.setHeader('Set-Cookie', cookie(token, sessionLifetime / 1000));
    return json(res, 200, { signedIn: true });
  }
  if (path === '/api/admin/logout') {
    await readJson(req, 1024);
    sessions.delete(tokenFrom(req));
    res.setHeader('Set-Cookie', cookie('', 0));
    return json(res, 200, { signedIn: false });
  }
  if (path !== '/api/admin/products') throw fail(404, 'Page not found.');
  if (!signedIn(req)) throw fail(401, 'Sign in to add products.');
  const body = await readJson(req, 7_010_000);
  if (!signedIn(req)) throw fail(401, 'Sign in to add products.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100 || !['Jewellery','Accessories','Gifts'].includes(body.category)
      || !Number.isInteger(body.price) || body.price < 0 || body.price > 9999999) {
    throw fail(400, 'Enter a product name, category and a whole-rupee price.');
  }
  if (typeof body.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image)) {
    throw fail(400, 'Choose a JPEG, PNG or WebP photo.');
  }
  const bytes = Buffer.from(body.image, 'base64');
  const mime = imageType(bytes);
  if (!mime || bytes.length > 5 * 1024 * 1024) throw fail(400, 'Choose a JPEG, PNG or WebP photo up to 5 MB.');
  const result = add.run(name, body.category, body.price, mime, bytes);
  return json(res, 201, { id: 'IE-P' + result.lastInsertRowid, name });
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try { await route(req, res); }
  catch (error) {
    if (res.headersSent) return res.destroy();
    if (!error.status) console.error(error);
    json(res, error.status ?? 500, { error: error.status ? error.message : 'Something went wrong.' });
  }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log('Storefront and /admin are ready on port ' + server.address().port);
});
