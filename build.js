#!/usr/bin/env node
/*
 * build.js — data/*.csv + src/engine.js + src/app.html → ページごとに docs/（中1 元素記号・化学式）と docs/chu2/（中2 用語＋イオン式）
 *            （各フォルダに単一 index.html ＋ sw.js ＋ manifest ＋ アイコン）
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
const SETS_PATH = path.join(ROOT, 'data', 'sets.csv');
const TPL_PATH = path.join(ROOT, 'src', 'app.html');
const SW_PATH = path.join(ROOT, 'src', 'sw.js');
const ENGINE_PATH = path.join(ROOT, 'src', 'engine.js');
const DIST = path.join(ROOT, 'docs');

/* ページ定義（1ページ = 1フォルダ。同一オリジンに並ぶので SW のキャッシュ名 prefix と保存キーは必ず別にする） */
const PAGES = [
  {
    id: 'main', csv: CSV_PATH, sets: SETS_PATH, out: DIST,
    title: '元素記号・化学式カード', shortName: '化学カード', storageKey: 'kagaku-card-v1', cachePrefix: 'kagaku-card-',
    defaultDir: 'sn', dirLabels: null, levelLabels: {}, swSkip: ['chu2/'], iconAccent: [255, 196, 61]
  },
  {
    // 中2テスト対策: 用語（terms CSV・section ごとに1範囲）＋イオン式。向きはカテゴリごとに別設定
    id: 'chu2', terms: path.join(ROOT, 'data', 'chu2-terms-2026-vol3.csv'),
    csv: path.join(ROOT, 'data', 'ions.csv'), sets: path.join(ROOT, 'data', 'chu2-sets.csv'), out: path.join(DIST, 'chu2'),
    title: '中2化学 テスト対策カード', shortName: '中2化学カード', storageKey: 'kagaku-chu2-v1', cachePrefix: 'kagaku-chu2-',
    defaultDir: 'ns', dirLabels: null,
    dirGroups: [
      { category: '用語', heading: '用語の向き', labels: { sn: '説明 → 用語', ns: '用語 → 説明' }, def: 'sn' },
      { category: 'イオン', heading: 'イオン式の向き', labels: { sn: '式 → 名称', ns: '名称 → 式' }, def: 'ns' }
    ],
    catLabels: { 'イオン': 'イオン式' },
    howto: [
      '<b>答えの面</b>をタップ → 答えが出る。<b>もう一度タップ、または左にスワイプ → 次のカード</b>',
      '<b>右にスワイプ</b> → 前のカードに戻る（押し直しできる）',
      '<b>頻度調整</b>（はじめはON）：「<b>覚えた</b>」を押したカードは出にくくなり、<b>2回続けて押す</b>と出なくなる。押さずに次へ進むと元に戻る。試験前に全部見たいときはOFFに',
      '<b>問題の面</b>をタップすると答えが少しずつ開く（ヒント）'
    ],
    levelLabels: { 'イオン:1': '単原子イオン', 'イオン:2': '多原子イオン' }, swSkip: [], iconAccent: [236, 96, 96]
  }
];

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

/**
 * 用語CSV（section,description,term,…）→ 正規化カード。使うのは section（範囲）・description・term だけ。
 * section はファイル順に level 1,2,… を振り、labels に { '用語:n': section } を入れる。kubun/source/note は読まない。
 */
function loadTerms(csvPath, labels) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  ['section', 'description', 'term'].forEach((h) => {
    if (idx(h) < 0) throw new Error('用語CSV ヘッダに ' + h + ' がない: ' + header.join(','));
  });
  const secs = [];
  return rows.slice(1).map((r) => {
    const sec = r[idx('section')].trim();
    if (secs.indexOf(sec) < 0) { secs.push(sec); if (labels) labels['用語:' + secs.length] = sec; }
    return E.normalizeCard({ category: '用語', level: secs.indexOf(sec) + 1, name: r[idx('term')], symbol: r[idx('description')], note: '' });
  });
}

/** ページのカード（用語 → その他の順）とレベル名 */
function loadPageCards(page) {
  const labels = Object.assign({}, page.levelLabels);
  const cards = (page.terms ? loadTerms(page.terms, labels) : []).concat(loadCards(page.csv));
  return { cards, labels };
}

/** data/sets.csv → 行配列 [{set, category, level, symbol}]（無ければ空） */
function loadSetRows(setsPath) {
  const p = setsPath || SETS_PATH;
  if (!fs.existsSync(p)) return [];
  const rows = parseCsv(fs.readFileSync(p, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  ['set', 'category'].forEach((h) => { if (idx(h) < 0) throw new Error('sets.csv ヘッダに ' + h + ' がない'); });
  return rows.slice(1).map((r) => ({
    set: r[idx('set')], category: r[idx('category')],
    level: idx('level') >= 0 ? r[idx('level')] : '', symbol: idx('symbol') >= 0 ? r[idx('symbol')] : ''
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
function iconPixel(size, accent) {
  const BG = [31, 79, 143], TILE = [255, 255, 255], ACC = accent || [255, 196, 61];
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
function buildPage(page, checkOnly) {
  const { cards, labels } = loadPageCards(page);
  const setRows = loadSetRows(page.sets);
  const errs = E.validateCards(cards).concat(E.validateSets(cards, setRows));
  if (errs.length) {
    console.error('✗ [' + page.id + '] データ検証に失敗（ビルドしません）: ' + path.relative(ROOT, page.csv));
    errs.forEach((e) => console.error('   - ' + e.msg));
    return false;
  }
  const levels = E.levelList(cards);
  const sets = E.buildSets(cards, setRows);
  if (checkOnly) console.log('✓ [' + page.id + '] 検証OK: ' + cards.length + '枚 / ' + levels.map((l) => l.category + 'Lv' + l.level + '=' + l.count).join(', ') +
    (sets.length ? ' / セット: ' + sets.map((s) => s.name + '=' + s.count + '枚').join(', ') : ''));
  if (checkOnly) return true;

  const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf8');
  const swSrc = fs.readFileSync(SW_PATH, 'utf8');
  const dataJson = JSON.stringify(cards.map((c) => ({ category: c.category, level: c.level, name: c.name, symbol: c.symbol, note: c.note })));
  const setsJson = JSON.stringify(setRows);
  const pageJson = JSON.stringify({
    storageKey: page.storageKey, defaultDir: page.defaultDir, dirLabels: page.dirLabels, levelLabels: labels,
    dirGroups: page.dirGroups || null, catLabels: page.catLabels || null, howto: page.howto || null
  });
  let html = fs.readFileSync(TPL_PATH, 'utf8');
  const version = crypto.createHash('sha1').update(engineSrc + dataJson + setsJson + pageJson + html + swSrc + JSON.stringify(page)).digest('hex').slice(0, 10);
  html = html.split('"__PAGE__"').join(pageJson)
    .split('__TITLE__').join(E.escapeHtml(page.title))
    .split('__SHORT_NAME__').join(E.escapeHtml(page.shortName))
    .split('"__DATA__"').join(dataJson)
    .split('"__SETS__"').join(setsJson)
    .split('__VERSION__').join(version)
    .split('/*__ENGINE__*/').join(engineSrc);
  if (/__(DATA|SETS|ENGINE|PAGE|TITLE|SHORT_NAME)__/.test(html)) throw new Error('テンプレートのプレースホルダ置換に失敗');
  const sw = swSrc.split('__CACHE_PREFIX__').join(page.cachePrefix)
    .split('"__SW_SKIP__"').join(JSON.stringify(page.swSkip))
    .split('__VERSION__').join(version);
  if (/__(CACHE_PREFIX|SW_SKIP|VERSION)__/.test(sw)) throw new Error('sw.js のプレースホルダ置換に失敗');

  const out = page.out;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'sw.js'), sw);
  fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({
    name: page.title, short_name: page.shortName, start_url: './', scope: './', display: 'standalone',
    background_color: '#f6f7f9', theme_color: '#1f4f8f', lang: 'ja',
    icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
  }, null, 2));
  [180, 192, 512].forEach((s) => fs.writeFileSync(path.join(out, 'icon-' + s + '.png'), makePng(s, iconPixel(s, page.iconAccent))));
  fs.writeFileSync(path.join(out, 'version.txt'), version + '\n');
  console.log('✓ [' + page.id + '] ' + path.relative(ROOT, out).split(path.sep).join('/') + '/ 生成 (version ' + version + ', index.html ' + (fs.statSync(path.join(out, 'index.html')).size / 1024).toFixed(1) + ' KB)');
  return true;
}

function build(opts) {
  opts = opts || {};
  // 全ページを先に検証してから書く（1ページでもNGなら何も書かない）
  const okAll = PAGES.map((p) => buildPage(p, true)).every(Boolean);
  if (!okAll) process.exit(1);
  if (opts.checkOnly) return;
  PAGES.forEach((p) => buildPage(p, false));
}

module.exports = { loadCards, loadTerms, loadPageCards, loadSetRows, parseCsv, build, PAGES };
if (require.main === module) build({ checkOnly: process.argv.includes('--check') });
