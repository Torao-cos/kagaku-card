#!/usr/bin/env node
/*
 * tools/import-list.js — owner の自然な書式のリストを cards.csv の行に変換する
 *
 *   node tools/import-list.js 化学式 input.txt            → 標準出力にCSV行（ヘッダなし）
 *   node tools/import-list.js 化学式 input.txt --append   → data/cards.csv 末尾に追記（重複行は飛ばす）
 *   node tools/import-list.js 元素記号 --range 1-20 --level 1   → 原子番号範囲から生成（36番まで）
 *
 * 受け付ける書式（すべて混在可）:
 *   【レベル2】亜鉛：Zn，鉄：Fe，銅：Cu          … 見出しでレベル切替。同一行に「名称：記号」を読点区切り
 *   【Lv3】                                        … 「レベル」「Lv」「LV」「level」いずれも可
 *   臭素 Br		ヨウ素 I	クロム Cr             … 空白/タブ区切りの「名称 記号」ペアが1行に複数
 *   水酸化ナトリウム	NaOH                        … 1行1ペア
 *   H₂O のような下付き、Ⅲ のようなローマ数字はそのまま書いてよい（正規化する）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');

const JA_NAMES = ['水素', 'ヘリウム', 'リチウム', 'ベリリウム', 'ホウ素', '炭素', '窒素', '酸素', 'フッ素', 'ネオン',
  'ナトリウム', 'マグネシウム', 'アルミニウム', 'ケイ素', 'リン', '硫黄', '塩素', 'アルゴン', 'カリウム', 'カルシウム',
  'スカンジウム', 'チタン', 'バナジウム', 'クロム', 'マンガン', '鉄', 'コバルト', 'ニッケル', '銅', '亜鉛',
  'ガリウム', 'ゲルマニウム', 'ヒ素', 'セレン', '臭素', 'クリプトン'];

const SEP = String.fromCharCode(1);   // 括弧内カンマの一時退避用（不可視文字をソースに置かない）

function csvField(s) { return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function parse(text, category) {
  const out = [];
  let level = null;
  text.split(/\r?\n/).forEach((line) => {
    let l = line.replace(/^#.*$/, '').trim();
    if (!l) return;
    const m = /^【\s*(?:レベル|Lv|LV|lv|level)\s*([0-9０-９]+)\s*】\s*(.*)$/i.exec(l);
    if (m) { level = parseInt(m[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)), 10); l = m[2].trim(); if (!l) return; }
    if (level === null) throw new Error('レベル見出し（【レベル1】等）より前に行があります: ' + line);
    // 行を語に分け、「名称」「記号」を貪欲にペアにする。
    //  - 「名称：記号」はコロンで分ける ／ 区切りは 空白・タブ・読点・（括弧の外の）カンマ
    //  - 記号らしい語 = 正規化後に /^[(A-Z][A-Za-z0-9()]*$/ に合う。日本語名称はこれに合わないので誤ペアにならない
    const protectedLine = l.replace(/\([^()]*\)/g, (seg) => seg.split(',').join(SEP));
    const words = protectedLine.split(/[：:]|[，、]\s*|,\s*|\s+/).map((w) => w.split(SEP).join(',').trim()).filter(Boolean);
    const isSym = (w) => /^[(A-Z][A-Za-z0-9()]*$/.test(E.normalizeSymbol(w));
    for (let i = 0; i < words.length; i++) {
      if (isSym(words[i])) { console.error('  ! 名称のない記号: ' + words[i]); continue; }
      if (i + 1 < words.length && isSym(words[i + 1])) {
        out.push(E.normalizeCard({ category, level, name: words[i], symbol: words[i + 1], note: '' }));
        i++;
      } else console.error('  ! 記号が見つからない: ' + words[i]);
    }
  });
  return out;
}

function fromRange(a, b, level) {
  const out = [];
  for (let z = a; z <= b; z++) {
    if (!JA_NAMES[z - 1]) throw new Error('原子番号 ' + z + ' の日本語名が JA_NAMES にない（36番まで対応）');
    out.push(E.normalizeCard({ category: '元素記号', level, name: JA_NAMES[z - 1], symbol: E.ELEMENTS[z - 1], note: '' }));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const category = args[0];
  if (category !== '元素記号' && category !== '化学式') { console.error('使い方: node tools/import-list.js <元素記号|化学式> <input.txt> [--append]'); process.exit(2); }
  let cards;
  const ri = args.indexOf('--range');
  if (ri >= 0) {
    const [a, b] = args[ri + 1].split('-').map(Number);
    const li = args.indexOf('--level');
    cards = fromRange(a, b, li >= 0 ? parseInt(args[li + 1], 10) : 1);
  } else {
    cards = parse(fs.readFileSync(args[1], 'utf8'), category);
  }
  const errs = E.validateCards(cards);
  if (errs.length) { console.error('✗ 変換結果に問題:'); errs.forEach((e) => console.error('   - ' + e.msg)); process.exit(1); }
  const lines = cards.map((c) => [c.category, c.level, c.name, c.symbol, c.note].map(csvField).join(','));
  if (args.includes('--append')) {
    const csvPath = path.join(__dirname, '..', 'data', 'cards.csv');
    const existing = fs.readFileSync(csvPath, 'utf8');
    const have = new Set(require('../build.js').loadCards(csvPath).map((c) => c.id));
    const add = lines.filter((ln, i) => !have.has(cards[i].id));
    fs.writeFileSync(csvPath, existing.replace(/\s*$/, '\n') + add.join('\n') + (add.length ? '\n' : ''));
    console.log('✓ ' + add.length + ' 行追記（重複 ' + (lines.length - add.length) + ' 行は飛ばした） → ' + csvPath);
  } else {
    process.stdout.write(lines.join('\n') + '\n');
  }
}
if (require.main === module) main();
module.exports = { parse, fromRange };
