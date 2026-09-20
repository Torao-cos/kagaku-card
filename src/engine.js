/*
 * engine.js — 元素記号・化学式カード 純関数エンジン
 *
 * Node / ブラウザ両対応（UMD風）:
 *   Node    : const E = require('./engine.js');
 *   Browser : window.KagakuEngine
 *
 * 方針:
 *  - すべて純関数。store は呼び出し側が持ち、ここでは引数で受けて必要なら返す（applyMark/undoMark は store.items を書き換える。他は不変）。
 *  - 乱数は rng（0以上1未満を返す関数）で注入。テストで seed 固定できる。
 *  - 「日付」は 'YYYY-MM-DD' 文字列で受ける（1日1回のstreak制限に使う）。
 *  - 仕様の正本は ../SPEC.md。ここに書く定数・ルールはそれに従う。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  if (typeof window !== 'undefined') { window.KagakuEngine = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ===================== 定数 ===================== */
  var CONFIG = {
    W_INIT: 1.0,
    W_O: 0.5,        // ○: 重み × 0.5
    W_X: 2.0,        // ×: 重み × 2.0（答え欄タップで次へ進んだ時も × 扱い）
    W_MIN: 0.1,
    W_MAX: 8.0,
    COOLDOWN_RATIO: 0.3,   // 直近 floor(0.3 × 候補数) 枚は出さない
    HIDE_STREAK: 2,        // 連続○ 2回で「覚えた」＝出なくなる
    STREAK_ONCE_PER_DAY: false,  // true にすると連続○カウントは1日1回まで（=最低2日かかる）。owner指示で既定 false（2026-09-20）
    HISTORY_MAX: 50        // スワイプで戻れる枚数
  };

  var DIRS = ['sn', 'ns'];   // sn = 記号→名称（既定） / ns = 名称→記号
  var DIR_LABEL = { sn: '記号 → 名称', ns: '名称 → 記号' };

  /* 118元素（検証用。データの誤字を弾く） */
  var ELEMENTS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
    'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu ' +
    'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr ' +
    'Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');
  var ELEMENT_SET = Object.create(null);
  ELEMENTS.forEach(function (e) { ELEMENT_SET[e] = true; });

  /* ===================== 文字列正規化 ===================== */

  // Unicode 下付き数字 → 半角。ローマ数字の合成文字 → ASCII。全角括弧 → 半角。
  var SUBS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
  var ROMAN = { 'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X' };
  function normalizeSymbol(s) {
    return String(s || '').trim()
      .replace(/[₀-₉]/g, function (c) { return SUBS[c]; })
      .replace(/[Ⅰ-Ⅹ]/g, function (c) { return ROMAN[c]; })
      .replace(/（/g, '(').replace(/）/g, ')')
      .replace(/\s+/g, '');
  }
  function normalizeName(s) {
    return String(s || '').trim()
      .replace(/[Ⅰ-Ⅹ]/g, function (c) { return ROMAN[c]; })
      .replace(/（/g, '(').replace(/）/g, ')')
      .replace(/［/g, '[').replace(/］/g, ']')
      .replace(/[･・]/g, function (c, i, str) {
        // 括弧内の区切り「Ⅱ･Ⅲ」は半角カンマに寄せる。それ以外の「・」は名称の一部なので残す
        var open = str.lastIndexOf('(', i), close = str.indexOf(')', i);
        return (open >= 0 && close > i) ? ',' : c;
      });
  }

  /* ===================== ヒント分割（SPEC §4） ===================== */

  /**
   * tokenize('Ca(OH)2') → ['Ca','(','O','H',')','2']
   * 単位: 元素記号 [A-Z][a-z]? ／ 連続数字 ／ 連続ローマ数字（[IVX]{2,}）／ それ以外1文字
   * ローマ数字判定を元素記号より先に見る（'III' の先頭 'I' をヨウ素にしない）。単独の I / V は元素記号。
   */
  function tokenize(str) {
    var s = String(str || '');
    var out = [];
    var i = 0;
    while (i < s.length) {
      var c = s[i];
      var m;
      if ((m = /^[IVX]{2,}/.exec(s.slice(i)))) { out.push(m[0]); i += m[0].length; continue; }
      if (/[A-Z]/.test(c)) {
        var t = c;
        if (i + 1 < s.length && /[a-z]/.test(s[i + 1])) t += s[i + 1];
        out.push(t); i += t.length; continue;
      }
      if ((m = /^[0-9]+/.exec(s.slice(i)))) { out.push(m[0]); i += m[0].length; continue; }
      // サロゲートペア（絵文字等）を1文字として扱う
      var cp = s.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      out.push(ch); i += ch.length;
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * トークン列 → HTML。
   *  - revealed: 先頭から何単位を見せるか（= tokens.length で全表示）
   *  - subscript: true なら数字トークンを <sub> にする（化学式側）
   *  - 未表示の単位は '＿' 1個で長さだけ示す
   */
  function renderTokens(tokens, revealed, subscript) {
    var n = Math.max(0, Math.min(revealed, tokens.length));
    var html = '';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (i < n) {
        if (subscript && /^[0-9]+$/.test(t)) html += '<sub>' + escapeHtml(t) + '</sub>';
        else html += escapeHtml(t);
      } else {
        html += '<span class="blank">＿</span>';
      }
    }
    return html;
  }

  /* ===================== カード・アイテム ===================== */

  function cardId(card) { return card.category + ':' + card.name + ':' + card.symbol; }
  function levelKey(card) { return card.category + ':' + card.level; }
  function itemKey(id, dir) { return id + '|' + dir; }

  /** CSV 由来の生行 → 正規化カード。level は整数化。 */
  function normalizeCard(row) {
    var c = {
      category: String(row.category || '').trim(),
      level: parseInt(row.level, 10),
      name: normalizeName(row.name),
      symbol: normalizeSymbol(row.symbol),
      note: String(row.note || '').trim()
    };
    c.id = cardId(c);
    return c;
  }

  /**
   * 検証。問題があれば {row, msg} の配列で返す（空配列 = OK）。
   */
  function validateCards(cards) {
    var errs = [];
    var seen = Object.create(null);
    cards.forEach(function (c, idx) {
      var where = (idx + 2) + '行目 ' + (c.name || '?') + ' / ' + (c.symbol || '?');
      if (c.category !== '元素記号' && c.category !== '化学式') errs.push({ row: idx, msg: where + ': category は 元素記号/化学式 のみ' });
      if (!(c.level >= 1 && c.level <= 9)) errs.push({ row: idx, msg: where + ': level は 1〜9 の整数' });
      if (!c.name) errs.push({ row: idx, msg: where + ': name が空' });
      if (!c.symbol) errs.push({ row: idx, msg: where + ': symbol が空' });
      if (seen[c.id]) errs.push({ row: idx, msg: where + ': 重複行' });
      seen[c.id] = true;
      // 化学式の健全性
      var depth = 0, ok = true;
      tokenize(c.symbol).forEach(function (t) {
        if (t === '(') depth++;
        else if (t === ')') { depth--; if (depth < 0) ok = false; }
        else if (/^[A-Z][a-z]?$/.test(t)) { if (!ELEMENT_SET[t]) errs.push({ row: idx, msg: where + ': 未知の元素記号 "' + t + '"' }); }
        else if (/^[0-9]+$/.test(t)) { /* ok */ }
        else errs.push({ row: idx, msg: where + ': symbol に使えない文字 "' + t + '"' });
      });
      if (depth !== 0 || !ok) errs.push({ row: idx, msg: where + ': 括弧の対応が取れていない' });
      if (c.category === '元素記号' && !ELEMENT_SET[c.symbol]) errs.push({ row: idx, msg: where + ': 元素記号として実在しない' });
      if (tokenize(c.symbol).join('') !== c.symbol) errs.push({ row: idx, msg: where + ': tokenize 往復不一致(symbol)' });
      if (tokenize(c.name).join('') !== c.name) errs.push({ row: idx, msg: where + ': tokenize 往復不一致(name)' });
    });
    return errs;
  }

  /** 選択範囲のカードだけ */
  function selectCards(cards, selectedLevelKeys) {
    var sel = Object.create(null);
    (selectedLevelKeys || []).forEach(function (k) { sel[k] = true; });
    return cards.filter(function (c) { return sel[levelKey(c)]; });
  }

  /**
   * カード × 方向 → アイテム。同一方向・同一問題面は統合（SPEC §5.1）。
   * 統合時の答え併記: 同カテゴリ内は「・」、カテゴリ間は「／」。カテゴリ順は 元素記号 → 化学式。
   * 戻り値: [{ key, dir, face, answer, faceIsFormula, answerIsFormula, note, cardIds:[..] }]
   */
  function buildItems(selectedCards, dirs) {
    var CAT_ORDER = { '元素記号': 0, '化学式': 1 };
    function catRank(c) { return CAT_ORDER[c] === undefined ? 9 : CAT_ORDER[c]; }
    var items = [];
    (dirs || DIRS).forEach(function (dir) {
      var byFace = Object.create(null);
      var order = [];
      selectedCards.forEach(function (c) {
        var face = (dir === 'sn') ? c.symbol : c.name;
        if (!byFace[face]) { byFace[face] = []; order.push(face); }
        byFace[face].push(c);
      });
      order.forEach(function (face) {
        var group = byFace[face];
        // 答え候補をカテゴリ別にまとめる（重複名は1回）
        var cats = Object.create(null), catOrder = [];
        var notes = [], seenAns = Object.create(null);
        var sorted = group.slice().sort(function (a, b) { return catRank(a.category) - catRank(b.category); });
        sorted.forEach(function (c) {
          var ans = (dir === 'sn') ? c.name : c.symbol;
          if (!cats[c.category]) { cats[c.category] = []; catOrder.push(c.category); }
          if (!seenAns[ans]) { seenAns[ans] = true; cats[c.category].push(ans); }   // 同名はカテゴリを跨いでも1回
          if (c.note && notes.indexOf(c.note) < 0) notes.push(c.note);
        });
        var answer = catOrder.map(function (cat) { return cats[cat].join('・'); })
          .filter(function (s) { return s.length > 0; }).join('／');
        items.push({
          key: 'F|' + dir + '|' + face,
          dir: dir,
          face: face,
          answer: answer,
          faceIsFormula: dir === 'sn',
          answerIsFormula: dir === 'ns',
          note: notes.join(' '),
          cardIds: group.map(function (c) { return c.id; })
        });
      });
    });
    return items;
  }

  /* ===================== 状態 ===================== */

  function emptyStore() {
    return {
      version: 1,
      settings: { dir: 'sn', freq: true, levels: [], bannerDismissed: false },   // 頻度調整は既定 ON（owner指示 2026-09-20）
      items: {}
    };
  }

  function freshState() { return { w: CONFIG.W_INIT, streak: 0, day: '', grad: false, o: 0, x: 0 }; }   // grad = 「覚えた」(非表示)

  function getState(store, id, dir) {
    return store.items[itemKey(id, dir)] || freshState();
  }

  /** 統合アイテムの集約状態: w = 最大, grad = 全部「覚えた」 */
  function itemState(store, item) {
    var w = 0, grad = true, any = false;
    item.cardIds.forEach(function (id) {
      var s = getState(store, id, item.dir);
      any = true;
      if (s.w > w) w = s.w;
      if (!s.grad) grad = false;
    });
    return { w: any ? w : CONFIG.W_INIT, grad: any ? grad : false };
  }

  function clamp(w) { return Math.min(CONFIG.W_MAX, Math.max(CONFIG.W_MIN, w)); }

  /**
   * ○× を適用（SPEC §5.3）。mark ∈ 'o' | 'x'。today = 'YYYY-MM-DD'（STREAK_ONCE_PER_DAY 用）。
   * 戻り値: undo 用のスナップショット {key: 直前state} — undoMark に渡す。
   */
  function applyMark(store, item, mark, today) {
    var snap = Object.create(null);
    item.cardIds.forEach(function (id) {
      var k = itemKey(id, item.dir);
      var prev = store.items[k] || freshState();
      snap[k] = JSON.parse(JSON.stringify(prev));
      var s = JSON.parse(JSON.stringify(prev));
      if (mark === 'o') {
        s.w = clamp(s.w * CONFIG.W_O);
        if (!CONFIG.STREAK_ONCE_PER_DAY || s.day !== today) { s.streak += 1; s.day = today; }
        if (s.streak >= CONFIG.HIDE_STREAK) s.grad = true;
        s.o += 1;
      } else {
        s.w = clamp(s.w * CONFIG.W_X);
        s.streak = 0;
        s.grad = false;
        s.x += 1;
      }
      store.items[k] = s;
    });
    return snap;
  }

  /** applyMark の巻き戻し（押し直し用） */
  function undoMark(store, snap) {
    Object.keys(snap).forEach(function (k) { store.items[k] = snap[k]; });
  }

  /* ===================== 抽選（SPEC §5.4） ===================== */

  function defaultRng() { return Math.random(); }

  /** mulberry32（テスト用の再現可能な乱数） */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** クールダウン枚数: floor(0.3N)。N≥2 なら最低1（同じカードの連続を防ぐ）、上限 N-1 */
  function cooldownFor(n) {
    if (n <= 1) return 0;
    return Math.min(n - 1, Math.max(1, Math.floor(CONFIG.COOLDOWN_RATIO * n)));
  }

  /**
   * 次のアイテムを選ぶ。
   *  items: buildItems の結果／store: 状態／recentKeys: 直近に出した item.key の配列（新しいものが末尾）
   *  freq: 頻度調整 ON(true)/OFF(false)／rng
   * 戻り値: item ／ null（頻度調整ONで候補ゼロ = 全部「覚えた」）
   */
  function pickNext(items, store, recentKeys, freq, rng) {
    rng = rng || defaultRng;
    var eligible = freq ? items.filter(function (it) { return !itemState(store, it).grad; }) : items.slice();
    if (eligible.length === 0) return null;
    var cd = cooldownFor(eligible.length);
    var recent = Object.create(null);
    (recentKeys || []).slice(-cd).forEach(function (k) { if (cd > 0) recent[k] = true; });
    var pool = eligible.filter(function (it) { return !recent[it.key]; });
    if (pool.length === 0) pool = eligible;
    if (!freq) return pool[Math.floor(rng() * pool.length)];
    var weights = pool.map(function (it) { return itemState(store, it).w; });
    var total = weights.reduce(function (s, x) { return s + x; }, 0);
    var r = rng() * total;
    for (var i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  /* ===================== 進捗（SPEC §6） ===================== */

  /**
   * レベル×方向ごとの { total, grad }。
   * 戻り値: { '元素記号:1': { sn:{total,grad}, ns:{total,grad} }, ... }（cards 全体に対して）
   */
  function progress(cards, store) {
    var out = Object.create(null);
    cards.forEach(function (c) {
      var lk = levelKey(c);
      if (!out[lk]) { out[lk] = {}; DIRS.forEach(function (d) { out[lk][d] = { total: 0, grad: 0 }; }); }
      DIRS.forEach(function (d) {
        out[lk][d].total += 1;
        if (getState(store, c.id, d).grad) out[lk][d].grad += 1;
      });
    });
    return out;
  }

  /** 選択範囲×方向の合計 { total, grad } */
  function summary(cards, store, selectedLevelKeys, dir) {
    var p = progress(cards, store);
    var total = 0, grad = 0;
    (selectedLevelKeys || []).forEach(function (lk) {
      if (p[lk] && p[lk][dir]) { total += p[lk][dir].total; grad += p[lk][dir].grad; }
    });
    return { total: total, grad: grad };
  }

  /** レベル×方向のリセット（dir 省略で両方向） */
  function resetLevel(store, cards, lk, dir) {
    var dirs = dir ? [dir] : DIRS;
    cards.forEach(function (c) {
      if (levelKey(c) !== lk) return;
      dirs.forEach(function (d) { delete store.items[itemKey(c.id, d)]; });
    });
  }

  /** レベル一覧（カテゴリ順・レベル昇順） */
  function levelList(cards) {
    var CAT_ORDER = { '元素記号': 0, '化学式': 1 };
    var seen = Object.create(null), list = [];
    cards.forEach(function (c) {
      var lk = levelKey(c);
      if (!seen[lk]) { seen[lk] = { key: lk, category: c.category, level: c.level, count: 0 }; list.push(seen[lk]); }
      seen[lk].count += 1;
    });
    list.sort(function (a, b) {
      var ca = CAT_ORDER[a.category] === undefined ? 9 : CAT_ORDER[a.category];
      var cb = CAT_ORDER[b.category] === undefined ? 9 : CAT_ORDER[b.category];
      return ca !== cb ? ca - cb : a.level - b.level;
    });
    return list;
  }

  return {
    CONFIG: CONFIG, DIRS: DIRS, DIR_LABEL: DIR_LABEL, ELEMENTS: ELEMENTS,
    normalizeSymbol: normalizeSymbol, normalizeName: normalizeName, normalizeCard: normalizeCard,
    tokenize: tokenize, renderTokens: renderTokens, escapeHtml: escapeHtml,
    cardId: cardId, levelKey: levelKey, itemKey: itemKey,
    validateCards: validateCards, selectCards: selectCards, buildItems: buildItems,
    emptyStore: emptyStore, freshState: freshState, getState: getState, itemState: itemState,
    applyMark: applyMark, undoMark: undoMark,
    makeRng: makeRng, cooldownFor: cooldownFor, pickNext: pickNext,
    progress: progress, summary: summary, resetLevel: resetLevel, levelList: levelList
  };
});
