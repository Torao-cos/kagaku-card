#!/usr/bin/env node
/*
 * build.js — data/cards.csv + src/engine.js + src/app.html → dist/（単一 index.html ＋ sw.js ＋ manifest ＋ アイコン）
 * 外部依存なし。Node 18+。
 *
 *   node build.js            ビルド（検証NGなら何も書かず exit 1）
 *   node build.js --check    検証だけ
 *
 * test/ からは require して loadCards() を再利用する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const E = require('./src/engine.js');

const ROOT = __dirname;
const CSV_PATH = path.join(ROOT, 'data', 'cards.csv');
const TPL_PATH = path.join(ROOT, 'src', 'app.html');
const SW_PATH = path.join(ROOT, 'src', 'sw.js');
const ENGINE_PATH = path.join(ROOT, 'src', 'engine.js');
const DIST = path.join(ROOT, 'dist');

/* ===================== CSV ===================== */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** CSV → 正規化カード配列（検証はしない。validateCards は呼び出し側） */
function loadCards(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath || CSV_PATH, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  ['category', 'level', 'name', 'symbol'].forEach((h) => {
    if (idx(h) < 0) throw new Error('CSV ヘッダに ' + h + ' がない: ' + header.join(','));
  });
  return rows.slice(1).map((r) => E.normalizeCard({
    category: r[idx('category')], level: r[idx('level')], name: r[idx('name')], symbol: r[idx('symbol')],
    note: idx('note') >= 0 ? r[idx('note')] : ''
  }));
}

/* ===================== PNG アイコン（周期表風タイル） ===================== */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** size×size の RGBA PNG。pixel(x,y) → [r,g,b,a] */
function makePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const p = pixel(x, y); const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
/** 角丸の紺地に 3×3 の白タイル（周期表のモチーフ）。 */
function iconPixel(size) {
  const BG = [31, 79, 143], TILE = [255, 255, 255], ACC = [255, 196, 61];
  const r = size * 0.22, pad = size * 0.18, gap = size * 0.035;
  const cell = (size - pad * 2 - gap * 2) / 3;
  return (x, y) => {
    // 角丸判定
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    const gx = (x - pad) / (cell + gap), gy = (y - pad) / (cell + gap);
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const inX = gx - ix < cell / (cell + gap), inY = gy - iy < cell / (cell + gap);
    if (ix >= 0 && ix < 3 && iy >= 0 && iy < 3 && inX && inY && gx >= 0 && gy >= 0) {
      return (ix === 1 && iy === 1) ? ACC.concat(255) : TILE.concat(255);
    }
    return BG.concat(255);
  };
}

/* ===================== ビルド ===================== */
function build(opts) {
  opts = opts || {};
  const cards = loadCards();
  const errs = E.validateCards(cards);
  if (errs.length) {
    console.error('✗ データ検証に失敗（ビルドしません）:');
    errs.forEach((e) => console.error('   - ' + e.msg));
    process.exit(1);
  }
  const levels = E.levelList(cards);
  console.log('✓ 検証OK: ' + cards.length + '枚 / ' + levels.map((l) => l.category + 'Lv' + l.level + '=' + l.count).join(', '));
  if (opts.checkOnly) return;

  const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf8');
  const dataJson = JSON.stringify(cards.map((c) => ({ category: c.category, level: c.level, name: c.name, symbol: c.symbol, note: c.note })));
  let html = fs.readFileSync(TPL_PATH, 'utf8');
  const version = crypto.createHash('sha1').update(engineSrc + dataJson + html + fs.readFileSync(SW_PATH, 'utf8')).digest('hex').slice(0, 10);
  html = html.split('/*__ENGINE__*/').join(engineSrc)
    .split('"__DATA__"').join(dataJson)
    .split('__VERSION__').join(version);
  if (html.indexOf('__DATA__') >= 0 || html.indexOf('__ENGINE__') >= 0) throw new Error('テンプレートのプレースホルダ置換に失敗');

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  fs.writeFileSync(path.join(DIST, 'sw.js'), fs.readFileSync(SW_PATH, 'utf8').split('__VERSION__').join(version));
  fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify({
    name: '元素記号・化学式カード', short_name: '化学カード', start_url: './', scope: './', display: 'standalone',
    background_color: '#f6f7f9', theme_color: '#1f4f8f', lang: 'ja',
    icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
  }, null, 2));
  [180, 192, 512].forEach((s) => fs.writeFileSync(path.join(DIST, 'icon-' + s + '.png'), makePng(s, iconPixel(s))));
  fs.writeFileSync(path.join(DIST, 'version.txt'), version + '\n');
  console.log('✓ dist/ 生成 (version ' + version + ', index.html ' + (fs.statSync(path.join(DIST, 'index.html')).size / 1024).toFixed(1) + ' KB)');
}

module.exports = { loadCards, parseCsv, build };
if (require.main === module) build({ checkOnly: process.argv.includes('--check') });
