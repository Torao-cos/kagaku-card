#!/usr/bin/env node
/* test/engine.test.js — エンジンの決定論テスト。node test/engine.test.js で実行。失敗があれば exit 1。 */
'use strict';
const assert = require('assert');
const path = require('path');
const E = require('../src/engine.js');
const { loadCards, loadSetRows } = require('../build.js');

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
t('× は streak と覚えたを解除、重みは基準1.0に戻す（上げない）', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd1');
  assert.ok(E.itemState(st, it).grad);
  E.applyMark(st, it, 'x', 'd1');
  const s = E.getState(st, 'a', 'sn');
  assert.strictEqual(s.grad, false); assert.strictEqual(s.streak, 0);
  assert.strictEqual(s.w, 1.0);
  E.applyMark(st, it, 'x', 'd1'); E.applyMark(st, it, 'x', 'd1');
  assert.strictEqual(E.getState(st, 'a', 'sn').w, 1.0, '× を重ねても 1.0 を超えない');
});
t('○→×→○ は連続でないので覚えたにならない', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'x', 'd1'); E.applyMark(st, it, 'o', 'd1');
  assert.strictEqual(E.getState(st, 'a', 'sn').streak, 1);
  assert.strictEqual(E.itemState(st, it).grad, false);
});
t('重みの下限 0.1', () => {
  const st = E.emptyStore(); const it = mkItem('a');
  for (let i = 0; i < 20; i++) E.applyMark(st, it, 'o', '2026-09-20');
  assert.ok(Math.abs(E.getState(st, 'a', 'sn').w - 0.1) < 1e-9);
});
t('resetCard で1枚だけ未に戻る', () => {
  const st = E.emptyStore();
  E.applyMark(st, mkItem('a'), 'o', 'd1'); E.applyMark(st, mkItem('a'), 'o', 'd1');
  E.applyMark(st, mkItem('b'), 'o', 'd1');
  E.resetCard(st, 'a', 'sn');
  assert.strictEqual(st.items['a|sn'], undefined);
  assert.strictEqual(st.items['b|sn'].streak, 1);
});
t('cardList: 覚えた → 記録あり → 未 の順', () => {
  const st = E.emptyStore();
  const lv2 = cards.filter((c) => c.category === '元素記号' && c.level === 2);
  E.applyMark(st, { key: 'k', dir: 'sn', cardIds: [lv2[3].id] }, 'o', 'd1');
  E.applyMark(st, { key: 'k', dir: 'sn', cardIds: [lv2[3].id] }, 'o', 'd1');
  E.applyMark(st, { key: 'k', dir: 'sn', cardIds: [lv2[5].id] }, 'o', 'd1');
  const list = E.cardList(cards, st, '元素記号:2', ['sn']);
  assert.strictEqual(list.length, 7);
  assert.strictEqual(list[0].card.id, lv2[3].id); assert.ok(list[0].grad);
  assert.strictEqual(list[1].card.id, lv2[5].id); assert.ok(list[1].any && !list[1].grad);
  assert.ok(!list[2].any);
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
t('ON: ○1回（0.5）のカードは未（1.0）のカードより出にくい・×は未と同じ', () => {
  const items = E.buildItems(E.selectCards(cards, ['化学式:2']), ['sn']);   // 14枚
  const st = E.emptyStore(); const rng = E.makeRng(11);
  const once = items[0], crossed = items[1], fresh = items[2];
  E.applyMark(st, once, 'o', 'd1');        // w=0.5
  E.applyMark(st, crossed, 'x', 'd1');     // w=1.0
  const cnt = {}; const recent = [];
  for (let i = 0; i < 14000; i++) {
    const it = E.pickNext(items, st, recent, true, rng);
    cnt[it.key] = (cnt[it.key] || 0) + 1; recent.push(it.key);
  }
  assert.ok(cnt[fresh.key] > cnt[once.key] * 1.5, 'fresh=' + cnt[fresh.key] + ' once=' + cnt[once.key]);
  assert.ok(Math.abs(cnt[crossed.key] / cnt[fresh.key] - 1) < 0.15, 'crossed=' + cnt[crossed.key] + ' fresh=' + cnt[fresh.key]);
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


/* ---------- セット（試験範囲・SPEC §2.5） ---------- */
const SET_ROWS = loadSetRows(path.join(__dirname, '..', 'data', 'sets.csv'));
const SETS = E.buildSets(cards, SET_ROWS);
t('sets.csv 検証 PASS・2026年度中1試験範囲 = 55枚', () => {
  assert.deepStrictEqual(E.validateSets(cards, SET_ROWS).map((e) => e.msg), []);
  assert.strictEqual(SETS.length, 1);
  assert.strictEqual(SETS[0].name, '2026年度中1試験範囲');
  assert.strictEqual(SETS[0].count, 55);   // 元素Lv1 20 + 個別6 + 化学式Lv1 13 + Lv2 14 + 個別2
  const ids = new Set(SETS[0].cardIds);
  assert.ok(ids.has('元素記号:マンガン:Mn')); assert.ok(ids.has('化学式:過酸化水素:H2O2')); assert.ok(ids.has('化学式:炭酸水素ナトリウム:NaHCO3'));
  assert.ok(!ids.has('元素記号:臭素:Br')); assert.ok(!ids.has('化学式:硫酸:H2SO4'));
});
t('validateSets は誤りを弾く', () => {
  const bad = [{ set: 'x', category: '元素記号', level: '', symbol: 'Xx' }, { set: 'x', category: '化学式', level: '2', symbol: 'H2O' }, { set: '', category: '化学式', level: '1', symbol: '' }];
  const msgs = E.validateSets(cards, bad).map((e) => e.msg);
  assert.ok(msgs.some((m) => /一致するカードが/.test(m)));
  assert.ok(msgs.some((m) => /どちらか一方/.test(m)));
  assert.ok(msgs.some((m) => /set 名が空/.test(m)));
});
t('selectCards: セットとレベルが重なっても1枚に', () => {
  const sel = E.selectCards(cards, [SETS[0].key, '元素記号:1'], SETS);
  assert.strictEqual(sel.length, 55);
  const sel2 = E.selectCards(cards, [SETS[0].key, '元素記号:3'], SETS);
  assert.strictEqual(sel2.length, 60);
});
t('summary / resetLevel / cardList がセットキーで動く', () => {
  const st = E.emptyStore();
  const mn = { key: 'k', dir: 'sn', cardIds: ['元素記号:マンガン:Mn'] };
  E.applyMark(st, mn, 'o', 'd1'); E.applyMark(st, mn, 'o', 'd1');
  assert.deepStrictEqual(E.summary(cards, st, [SETS[0].key], 'sn', SETS), { total: 55, grad: 1 });
  const list = E.cardList(cards, st, SETS[0].key, ['sn'], SETS);
  assert.strictEqual(list.length, 55); assert.ok(list[0].grad && list[0].card.symbol === 'Mn');
  E.resetLevel(st, cards, SETS[0].key, 'sn', SETS);
  assert.deepStrictEqual(E.summary(cards, st, [SETS[0].key], 'sn', SETS), { total: 55, grad: 0 });
});

/* ---------- イオン式（data/ions.csv・/chu2/ ページで使う） ---------- */
const ION_TOK = {
  'Ca^2+': ['Ca', '^2+'],
  'SO4^2-': ['S', 'O', '4', '^2-'],
  'Cl^-': ['Cl', '^-'],
  'NH4^+': ['N', 'H', '4', '^+'],
  'H^+': ['H', '^+']
};
Object.keys(ION_TOK).forEach((s) => {
  t('tokenize ion ' + s, () => assert.deepStrictEqual(E.tokenize(s), ION_TOK[s]));
});
t('renderTokens ion: 電荷は <sup>・マイナスは U+2212・^ は出さない', () => {
  assert.strictEqual(E.renderTokens(E.tokenize('SO4^2-'), 99, true), 'SO<sub>4</sub><sup>2−</sup>');
  assert.strictEqual(E.renderTokens(E.tokenize('Ca^2+'), 99, true), 'Ca<sup>2+</sup>');
  assert.strictEqual(E.renderTokens(E.tokenize('Cl^-'), 99, true), 'Cl<sup>−</sup>');
  assert.strictEqual(E.renderTokens(E.tokenize('NH4^+'), 3, true), 'NH<sub>4</sub><span class="blank">＿</span>');
  assert.strictEqual(E.renderTokens(E.tokenize('Cl^-'), 1, true), 'Cl<span class="blank">＿</span>');
  ['H^+', 'Al^3+', 'CO3^2-'].forEach((s) => assert.ok(E.renderTokens(E.tokenize(s), 99, true).indexOf('^') < 0, s));
});
t('normalizeSymbol 全角の電荷記号', () => assert.strictEqual(E.normalizeSymbol('SO₄＾2−'), 'SO4^2-'));
const ions = loadCards(path.join(__dirname, '..', 'data', 'ions.csv'));
t('ions.csv 検証 PASS・単原子13 / 多原子5', () => {
  assert.deepStrictEqual(E.validateCards(ions).map((e) => e.msg), []);
  assert.strictEqual(ions.length, 18);
  assert.ok(ions.every((c) => c.category === 'イオン'));
  assert.strictEqual(ions.filter((c) => c.level === 1).length, 13);
  assert.strictEqual(ions.filter((c) => c.level === 2).length, 5);
  assert.deepStrictEqual(E.levelList(ions).map((l) => l.key), ['イオン:1', 'イオン:2']);
  assert.ok(ions.some((c) => c.symbol === 'Fe^2+') && !ions.some((c) => c.symbol === 'Fe^3+'));
});
t('validate はイオンの誤りを弾く', () => {
  const bad = (sym) => E.validateCards([E.normalizeCard({ category: 'イオン', level: 1, name: 'テスト', symbol: sym })]).map((e) => e.msg);
  ['Ca^2', 'Ca^+2', 'Xx^+', 'Ca^2+^', 'Ca', 'Ca^2+^2+', '^2+'].forEach((s) => assert.ok(bad(s).length > 0, s + ' should fail'));
  assert.ok(bad('Xx^+').some((m) => /未知の元素記号 "Xx"/.test(m)));
  assert.deepStrictEqual(bad('Ca^2+'), []);
  const notIon = E.validateCards([E.normalizeCard({ category: '化学式', level: 1, name: 'テスト', symbol: 'Ca^2+' })]);
  assert.ok(notIon.some((e) => /イオン だけ/.test(e.msg)));
});
t('PAGES: 両ページのCSVが読めて検証PASS・保存キーとキャッシュprefixが別', () => {
  const { PAGES, loadPageCards } = require('../build.js');
  assert.deepStrictEqual(PAGES.map((p) => p.id), ['main', 'chu2']);
  PAGES.forEach((p) => {
    const cs = loadPageCards(p).cards;
    assert.deepStrictEqual(E.validateCards(cs).concat(E.validateSets(cs, loadSetRows(p.sets))).map((e) => e.msg), [], p.id);
  });
  assert.strictEqual(PAGES[0].storageKey, 'kagaku-card-v1');
  assert.strictEqual(PAGES[1].storageKey, 'kagaku-chu2-v1');
  assert.strictEqual(PAGES[1].cachePrefix, 'kagaku-chu2-');
  assert.strictEqual(PAGES[1].out, path.join(__dirname, '..', 'docs', 'chu2'));
  assert.deepStrictEqual(PAGES[0].swSkip, ['chu2/']);
  assert.ok(PAGES[0].cachePrefix.indexOf(PAGES[1].cachePrefix) !== 0 && PAGES[1].cachePrefix.indexOf(PAGES[0].cachePrefix) !== 0);
});

/* ---------- 中2テスト対策（/chu2/ ページ: 用語＋イオン式） ---------- */
const { loadTerms, loadPageCards, PAGES } = require('../build.js');
const CHU2 = PAGES.find((p) => p.id === 'chu2');
const termLabels = {};
const terms = loadTerms(CHU2.terms, termLabels);
const SECTIONS = ['§1 水溶液の液性', '§2 酸・アルカリとイオン', '§3 中和とイオン', '§4-1 金属のイオンへのなりやすさ', '§4-2 電池とそのしくみ', '§4-3 身の回りの電池'];
t('用語CSV: 50枚・検証PASS・section がファイル順に Lv1..6', () => {
  assert.strictEqual(terms.length, 50);
  assert.deepStrictEqual(E.validateCards(terms).map((e) => e.msg), []);
  assert.deepStrictEqual(E.levelList(terms).map((l) => termLabels[l.key]), SECTIONS);
  assert.deepStrictEqual(E.levelList(terms).map((l) => l.count), [8, 8, 8, 5, 17, 4]);
  assert.ok(terms.every((c) => c.category === '用語' && c.note === ''), 'note は読まない');
});
t('用語: 文字列は正規化しない（全角括弧・−・空白そのまま）', () => {
  const c = terms.find((x) => x.name === '塩（えん）');
  assert.ok(c, '全角括弧が残る');
  assert.ok(terms.some((x) => x.symbol.indexOf('H+とOH−') >= 0));
  assert.strictEqual(E.normalizeCard(c).symbol, c.symbol, 'ブラウザ側の再正規化で変わらない');
});
t('用語の検証: 空・問題文重複を弾き、元素チェックはしない', () => {
  const mk = (desc, term) => E.normalizeCard({ category: '用語', level: 1, name: term, symbol: desc });
  assert.deepStrictEqual(E.validateCards([mk('Xxを含む説明', 'Zz')]).map((e) => e.msg), []);
  assert.ok(E.validateCards([mk('', 'a')]).some((e) => /問題文が空/.test(e.msg)));
  assert.ok(E.validateCards([mk('a', '')]).some((e) => /答えが空/.test(e.msg)));
  assert.ok(E.validateCards([mk('同じ', 'a'), mk('同じ', 'b')]).some((e) => /問題文の重複/.test(e.msg)));
});
t('用語 sn = 説明→用語・ns = 用語→説明・note は出ない・下付きにしない', () => {
  const sel = E.selectCards(terms, ['用語:1']);
  const sn = E.buildItems(sel, ['sn']);
  assert.strictEqual(sn.length, 8);
  const lit = sn.find((it) => it.answer === 'リトマス紙');
  assert.ok(lit.face.indexOf('青色のものが赤色に') === 0);
  assert.strictEqual(lit.note, '');
  assert.ok(sn.every((it) => it.plain && !it.faceIsFormula && !it.answerIsFormula));
  const ns = E.buildItems(sel, ['ns']);
  assert.strictEqual(ns.find((it) => it.face === 'リトマス紙').answer, lit.face);
});
t('カテゴリ別の向き: 用語とイオンが別々に効く', () => {
  const all = loadPageCards(CHU2).cards;
  const sel = E.selectCards(all, ['用語:1', 'イオン:1']);
  const items = E.buildItems(sel, { '用語': ['sn'], 'イオン': ['ns'] });
  const t1 = items.filter((it) => it.plain), io = items.filter((it) => !it.plain);
  assert.strictEqual(t1.length, 8); assert.ok(t1.every((it) => it.dir === 'sn'));
  assert.strictEqual(io.length, 13); assert.ok(io.every((it) => it.dir === 'ns' && it.answerIsFormula));
  const mix = E.buildItems(sel, { '用語': ['sn', 'ns'], 'イオン': ['sn'] });
  assert.strictEqual(mix.filter((it) => it.plain).length, 16);
  assert.ok(mix.filter((it) => !it.plain).every((it) => it.dir === 'sn' && it.faceIsFormula));
  assert.deepStrictEqual(E.effectiveDirs('用語', { 'イオン': ['ns'] }), ['sn', 'ns']);
});
t('用語の進捗: レベル総数 = その section の枚数（方向ごと）・列はカテゴリ×方向', () => {
  const all = loadPageCards(CHU2).cards;
  const st = E.emptyStore();
  const it = E.buildItems(E.selectCards(all, ['用語:5']), { '用語': ['sn'] })[0];
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd1');
  assert.deepStrictEqual(E.progress(all, st)['用語:5'], { sn: { total: 17, grad: 1 }, ns: { total: 17, grad: 0 } });
  const dirs = { '用語': ['sn'], 'イオン': ['ns', 'sn'] };
  const tr = E.progressTracks(E.selectCards(all, ['用語:5', 'イオン:2']), st, dirs);
  assert.deepStrictEqual(tr.map((x) => [x.key, x.total, x.grad]), [['用語|sn', 17, 1], ['イオン|ns', 5, 0], ['イオン|sn', 5, 0]]);
  assert.deepStrictEqual(E.progressTracks([], st, dirs), []);
  const list = E.cardList(all, st, '用語:5', dirs);
  assert.strictEqual(list.length, 17); assert.ok(list[0].grad); assert.deepStrictEqual(Object.keys(list[0].states), ['sn']);
  E.resetLevel(st, all, '用語:5');
  assert.deepStrictEqual(E.progress(all, st)['用語:5'].sn, { total: 17, grad: 0 });
});
t('progressTracks（共通の向き）は従来の summary と同じ', () => {
  const st = E.emptyStore();
  const it = E.buildItems(E.selectCards(cards, ['元素記号:2']), ['sn'])[0];
  E.applyMark(st, it, 'o', 'd1'); E.applyMark(st, it, 'o', 'd1');
  const sel = E.selectCards(cards, ['元素記号:2', '元素記号:3']);
  assert.deepStrictEqual(E.progressTracks(sel, st, ['sn', 'ns']).map((x) => [x.key, x.total, x.grad]), [['sn', 12, 1], ['ns', 12, 0]]);
  assert.deepStrictEqual(E.progressTracks([], st, ['ns']).map((x) => [x.key, x.total]), [['ns', 0]]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
