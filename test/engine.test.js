#!/usr/bin/env node
/* test/engine.test.js — エンジンの決定論テスト。node test/engine.test.js で実行。失敗があれば exit 1。 */
'use strict';
const assert = require('assert');
const path = require('path');
const E = require('../src/engine.js');
const { loadCards } = require('../build.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('✗ ' + name + '\n    ' + (e && e.message)); }
}

/* ---------- tokenize（SPEC §4 の表そのまま） ---------- */
const TOK = {
  'H2O': ['H', '2', 'O'],
  'Ca(OH)2': ['Ca', '(', 'O', 'H', ')', '2'],
  'C6H12O6': ['C', '6', 'H', '12', 'O', '6'],
  'NaOH': ['Na', 'O', 'H'],
  '(NH4)2CO3': ['(', 'N', 'H', '4', ')', '2', 'C', 'O', '3'],
  'CH3CH2OH': ['C', 'H', '3', 'C', 'H', '2', 'O', 'H'],
  '酸化鉄(III)[赤さび]': ['酸', '化', '鉄', '(', 'III', ')', '[', '赤', 'さ', 'び', ']'],
  '酸化鉄(II,III)[黒さび]': ['酸', '化', '鉄', '(', 'II', ',', 'III', ')', '[', '黒', 'さ', 'び', ']'],
  'ナトリウム': ['ナ', 'ト', 'リ', 'ウ', 'ム'],
  'I': ['I'], 'V': ['V'],       // 単独はヨウ素・バナジウム
  'I2': ['I', '2'],
  '窒素(分子)': ['窒', '素', '(', '分', '子', ')'],
  '炭素／黒鉛・ダイヤモンド': ['炭', '素', '／', '黒', '鉛', '・', 'ダ', 'イ', 'ヤ', 'モ', 'ン', 'ド']
};
Object.keys(TOK).forEach((s) => {
  t('tokenize ' + s, () => assert.deepStrictEqual(E.tokenize(s), TOK[s]));
});

/* ---------- 正規化 ---------- */
t('normalizeSymbol 下付き→半角', () => assert.strictEqual(E.normalizeSymbol('H₂O'), 'H2O'));
t('normalizeSymbol 全角括弧', () => assert.strictEqual(E.normalizeSymbol('Ca（OH）₂'), 'Ca(OH)2'));
t('normalizeName ローマ数字合成文字', () => assert.strictEqual(E.normalizeName('酸化鉄(Ⅲ)[赤さび]'), '酸化鉄(III)[赤さび]'));
t('normalizeName 括弧内の・はカンマ', () => assert.strictEqual(E.normalizeName('酸化鉄(Ⅱ･Ⅲ)[黒さび]'), '酸化鉄(II,III)[黒さび]'));
t('normalizeName 括弧外の・は残す', () => assert.strictEqual(E.normalizeName('黒鉛・ダイヤモンド'), '黒鉛・ダイヤモンド'));

/* ---------- renderTokens ---------- */
t('renderTokens 部分表示+下付き', () => {
  const html = E.renderTokens(E.tokenize('H2O'), 2, true);
  assert.strictEqual(html, 'H<sub>2</sub><span class="blank">＿</span>');
});
t('renderTokens 全表示', () => {
  assert.strictEqual(E.renderTokens(E.tokenize('NaOH'), 99, true), 'NaOH');
});
t('renderTokens 名称側は下付きにしない', () => {
  assert.strictEqual(E.renderTokens(E.tokenize('水2'), 2, false), '水2');
});

/* ---------- 実データの検証 ---------- */
const cards = loadCards(path.join(__dirname, '..', 'data', 'cards.csv'));
t('データ検証 PASS', () => {
  const errs = E.validateCards(cards);
  assert.deepStrictEqual(errs.map((e) => e.msg), []);
});
t('枚数 元素記号50 / 化学式54', () => {
  const n = (cat) => cards.filter((c) => c.category === cat).length;
  assert.strictEqual(n('元素記号'), 50);
  assert.strictEqual(n('化学式'), 54);
});
t('元素記号Lv1 = 原子番号1〜20', () => {
  const lv1 = cards.filter((c) => c.category === '元素記号' && c.level === 1).map((c) => c.symbol);
  assert.deepStrictEqual(lv1, E.ELEMENTS.slice(0, 20));
});
t('元素記号Lv5 = 21〜36の残り7 + Mo W Sr Cs U', () => {
  const used = new Set(cards.filter((c) => c.category === '元素記号' && c.level <= 4).map((c) => c.symbol));
  const rest = E.ELEMENTS.slice(20, 36).filter((s) => !used.has(s));
  const lv5 = cards.filter((c) => c.category === '元素記号' && c.level === 5).map((c) => c.symbol);
  assert.deepStrictEqual(lv5, rest.concat(['Mo', 'W', 'Sr', 'Cs', 'U']));
  assert.strictEqual(rest.length, 7);
});
t('訂正が入っている（Fe2O3=III, (NH4)2CO3）', () => {
  assert.ok(cards.some((c) => c.symbol === 'Fe2O3' && c.name.indexOf('(III)') >= 0));
  assert.ok(cards.some((c) => c.symbol === '(NH4)2CO3'));
  assert.ok(!cards.some((c) => c.symbol === 'NH4CO3'));
});
t('validate は誤字を弾く', () => {
  const bad = E.normalizeCard({ category: '化学式', level: 2, name: 'テスト', symbol: 'NhOH' });
  assert.ok(E.validateCards([bad]).some((e) => /未知の元素記号 "Nh"/.test(e.msg)) === false, 'Nh はニホニウムで実在する');
  const bad2 = E.normalizeCard({ category: '化学式', level: 2, name: 'テスト', symbol: 'Xx2' });
  assert.ok(E.validateCards([bad2]).some((e) => /未知の元素記号 "Xx"/.test(e.msg)));
  const bad3 = E.normalizeCard({ category: '化学式', level: 2, name: 'テスト', symbol: 'Ca(OH' });
  assert.ok(E.validateCards([bad3]).some((e) => /括弧/.test(e.msg)));
  const dup = E.validateCards([cards[0], cards[0]]);
  assert.ok(dup.some((e) => /重複/.test(e.msg)));
});

/* ---------- 統合（SPEC §5.1） ---------- */
const ALL_LEVELS = E.levelList(cards).map((l) => l.key);
t('統合 C → 炭素／黒鉛・ダイヤモンド（全範囲）', () => {
  const items = E.buildItems(E.selectCards(cards, ALL_LEVELS), ['sn']);
  const c = items.find((it) => it.face === 'C');
  assert.strictEqual(c.answer, '炭素／黒鉛・ダイヤモンド');
  assert.strictEqual(c.cardIds.length, 3);
});
t('統合 C → 炭素（元素記号Lv1のみ）', () => {
  const items = E.buildItems(E.selectCards(cards, ['元素記号:1']), ['sn']);
  assert.strictEqual(items.find((it) => it.face === 'C').answer, '炭素');
});
t('統合 Ag → 銀（同名は1回）', () => {
  const items = E.buildItems(E.selectCards(cards, ALL_LEVELS), ['sn']);
  assert.strictEqual(items.find((it) => it.face === 'Ag').answer, '銀');
});
t('名称→記号 では 黒鉛/ダイヤモンド は別カード', () => {
  const items = E.buildItems(E.selectCards(cards, ALL_LEVELS), ['ns']);
  assert.ok(items.find((it) => it.face === '黒鉛'));
  assert.ok(items.find((it) => it.face === 'ダイヤモンド'));
  assert.strictEqual(items.find((it) => it.face === '銀').cardIds.length, 2);
});
t('アイテム数 全範囲 sn', () => {
  const items = E.buildItems(E.selectCards(cards, ALL_LEVELS), ['sn']);
  // 104カード − 統合分（Ag,Fe,Ca,Na,He,Ne,Ar 各1・C 2）= 104-9 = 95
  assert.strictEqual(items.length, 95);
});

/* ---------- ○× と「覚えた」（SPEC §5.3） ---------- */
function mkItem(id) { return { key: 'k' + id, dir: 'sn', cardIds: [id] }; }
t('○ 2回続けて → 覚えた（同日でもよい・既定）', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  E.applyMark(st, it, 'o', '2026-09-20');
  assert.strictEqual(E.itemState(st, it).grad, false);
  E.applyMark(st, it, 'o', '2026-09-20');
  assert.strictEqual(E.getState(st, 'a', 'sn').streak, 2);
  assert.strictEqual(E.itemState(st, it).grad, true);
});
t('STREAK_ONCE_PER_DAY=true なら同日2連続では覚えたにならない（フラグで戻せる）', () => {
  const prev = E.CONFIG.STREAK_ONCE_PER_DAY; E.CONFIG.STREAK_ONCE_PER_DAY = true;
  try {
    const st = E.emptyStore(); const it = mkItem('a');
    E.applyMark(st, it, 'o', '2026-09-20'); E.applyMark(st, it, 'o', '2026-09-20');
    assert.strictEqual(E.getState(st, 'a', 'sn').streak, 1);
    E.applyMark(st, it, 'o', '2026-09-21');
    assert.strictEqual(E.itemState(st, it).grad, true);
  } finally { E.CONFIG.STREAK_ONCE_PER_DAY = prev; }
});
t('× は streak と覚えたを解除、重み×2', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd1');
  assert.ok(E.itemState(st, it).grad);
  E.applyMark(st, it, 'x', 'd1');
  const s = E.getState(st, 'a', 'sn');
  assert.strictEqual(s.grad, false); assert.strictEqual(s.streak, 0);
  assert.ok(Math.abs(s.w - 0.5) < 1e-9, 'w=' + s.w);   // 1.0*0.5*0.5=0.25 → ×2 = 0.5
});
t('○→×→○ は連続でないので覚えたにならない', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'x', 'd1'); E.applyMark(st, it, 'o', 'd1');
  assert.strictEqual(E.getState(st, 'a', 'sn').streak, 1);
  assert.strictEqual(E.itemState(st, it).grad, false);
});
t('重みの上下限', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  for (let i = 0; i < 10; i++) E.applyMark(st, it, 'x', '2026-09-20');
  assert.strictEqual(E.getState(st, 'a', 'sn').w, 8.0);
  for (let i = 0; i < 20; i++) E.applyMark(st, it, 'o', '2026-09-20');
  assert.ok(Math.abs(E.getState(st, 'a', 'sn').w - 0.1) < 1e-9);
});
t('undoMark で押し直し', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  const snap = E.applyMark(st, it, 'x', '2026-09-20');
  E.undoMark(st, snap);
  assert.strictEqual(st.items['a|sn'].w, 1.0);
  E.applyMark(st, it, 'o', '2026-09-20');
  assert.strictEqual(st.items['a|sn'].x, 0); assert.strictEqual(st.items['a|sn'].o, 1);
});
t('統合アイテム: 全構成カードに適用・grad は全部で判定', () => {
  const st = E.emptyStore(); const it = { key: 'k', dir: 'sn', cardIds: ['a', 'b'] };
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd1');
  assert.ok(E.getState(st, 'a', 'sn').grad && E.getState(st, 'b', 'sn').grad);
  E.applyMark(st, mkItem('b'), 'x', 'd1');
  assert.strictEqual(E.itemState(st, it).grad, false);
  assert.strictEqual(E.itemState(st, it).w, E.getState(st, 'b', 'sn').w);   // 最大
});

/* ---------- 抽選（SPEC §5.4） ---------- */
t('cooldownFor', () => {
  assert.strictEqual(E.cooldownFor(1), 0);
  assert.strictEqual(E.cooldownFor(2), 1);
  assert.strictEqual(E.cooldownFor(3), 1);
  assert.strictEqual(E.cooldownFor(7), 2);
  assert.strictEqual(E.cooldownFor(10), 3);
  assert.strictEqual(E.cooldownFor(95), 28);
});
t('クールダウン: 直近 floor(0.3N) 枚は絶対に出ない（OFF・2000回）', () => {
  const items = E.buildItems(E.selectCards(cards, ALL_LEVELS), ['sn']);
  const st = E.emptyStore(); const rng = E.makeRng(7);
  const recent = []; const cd = E.cooldownFor(items.length);
  for (let i = 0; i < 2000; i++) {
    const it = E.pickNext(items, st, recent, false, rng);
    assert.ok(recent.slice(-cd).indexOf(it.key) < 0, 'repeat within cooldown at ' + i);
    recent.push(it.key);
  }
});
t('クールダウン: 7枚範囲でも同じカードが連続しない（ON）', () => {
  const items = E.buildItems(E.selectCards(cards, ['元素記号:2']), ['sn']);
  assert.strictEqual(items.length, 7);
  const st = E.emptyStore(); const rng = E.makeRng(3); const recent = [];
  for (let i = 0; i < 500; i++) {
    const it = E.pickNext(items, st, recent, true, rng);
    if (recent.length) assert.notStrictEqual(it.key, recent[recent.length - 1]);
    recent.push(it.key);
  }
});
t('ON: 覚えた済みは出ない／全部覚えたで null', () => {
  const items = E.buildItems(E.selectCards(cards, ['元素記号:2']), ['sn']);
  const st = E.emptyStore();
  items.slice(0, 6).forEach((it) => { E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd2'); });
  const rng = E.makeRng(1);
  for (let i = 0; i < 50; i++) assert.strictEqual(E.pickNext(items, st, [], true, rng).key, items[6].key);
  E.applyMark(st, items[6], 'o', 'd1'); E.applyMark(st, items[6], 'o', 'd2');
  assert.strictEqual(E.pickNext(items, st, [], true, rng), null);
  // OFF なら全部出る
  assert.ok(E.pickNext(items, st, [], false, rng) !== null);
});
t('ON: 重い（×した）カードほど多く出る', () => {
  const items = E.buildItems(E.selectCards(cards, ['化学式:2']), ['sn']);   // 14枚
  const st = E.emptyStore(); const rng = E.makeRng(11);
  const hard = items[0], easy = items[1];
  for (let i = 0; i < 3; i++) E.applyMark(st, hard, 'x', 'd1');   // w=8
  E.applyMark(st, easy, 'o', 'd1');   // w=0.5（2回○すると覚えた扱いで出なくなるので1回だけ）
  const cnt = {}; const recent = [];
  for (let i = 0; i < 5000; i++) {
    const it = E.pickNext(items, st, recent, true, rng);
    cnt[it.key] = (cnt[it.key] || 0) + 1; recent.push(it.key);
  }
  assert.ok(cnt[hard.key] > cnt[easy.key] * 3, 'hard=' + cnt[hard.key] + ' easy=' + cnt[easy.key]);
});
t('OFF: 一様（重みを無視）', () => {
  const items = E.buildItems(E.selectCards(cards, ['化学式:2']), ['sn']);
  const st = E.emptyStore(); const rng = E.makeRng(5);
  for (let i = 0; i < 3; i++) E.applyMark(st, items[0], 'x', 'd1');
  const cnt = {}; const recent = [];
  for (let i = 0; i < 14000; i++) { const it = E.pickNext(items, st, recent, false, rng); cnt[it.key] = (cnt[it.key] || 0) + 1; recent.push(it.key); }
  const vals = Object.values(cnt);
  assert.ok(Math.max(...vals) / Math.min(...vals) < 1.2, 'spread ' + Math.min(...vals) + '..' + Math.max(...vals));
});

/* ---------- 進捗 ---------- */
t('progress / summary / resetLevel', () => {
  const st = E.emptyStore();
  const it = E.buildItems(E.selectCards(cards, ['元素記号:2']), ['sn'])[0];
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd2');
  const p = E.progress(cards, st);
  assert.deepStrictEqual(p['元素記号:2'].sn, { total: 7, grad: 1 });
  assert.deepStrictEqual(p['元素記号:2'].ns, { total: 7, grad: 0 });
  assert.deepStrictEqual(E.summary(cards, st, ['元素記号:2', '元素記号:3'], 'sn'), { total: 12, grad: 1 });
  E.resetLevel(st, cards, '元素記号:2', 'sn');
  assert.deepStrictEqual(E.progress(cards, st)['元素記号:2'].sn, { total: 7, grad: 0 });
});
t('levelList 順序', () => {
  assert.deepStrictEqual(E.levelList(cards).map((l) => l.key),
    ['元素記号:1', '元素記号:2', '元素記号:3', '元素記号:4', '元素記号:5', '化学式:1', '化学式:2', '化学式:3', '化学式:4']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
