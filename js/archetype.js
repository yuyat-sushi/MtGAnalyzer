/*
 * アーキタイプ判定
 * MTGOFormatData（https://github.com/Badaro/MTGOFormatData, MIT License）の
 * Archetypes / Fallbacks 定義を、MTGOArchetypeParser と同じ考え方で当てはめる。
 * ブラウザ（window.Archetype）と Node.js（require）の両方から使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Archetype = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const key = n => {
    let s = String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (/[^/]\/[^/]/.test(s) && !s.includes('//')) s = s.replace(/\s*\/\s*/, ' // ');
    s = s.replace(/\s*\/\/\s*/g, ' // ');
    return s;
  };
  // 両面・分割カードは表面の名前でも一致させる
  const keysOf = n => { const k = key(n); return k.includes(' // ') ? [k, k.split(' // ')[0]] : [k]; };

  const COLOR_NAMES = {
    W: 'Mono White', U: 'Mono Blue', B: 'Mono Black', R: 'Mono Red', G: 'Mono Green',
    WU: 'Azorius', UB: 'Dimir', BR: 'Rakdos', RG: 'Gruul', WG: 'Selesnya',
    WB: 'Orzhov', UR: 'Izzet', BG: 'Golgari', WR: 'Boros', UG: 'Simic',
    WUB: 'Esper', UBR: 'Grixis', BRG: 'Jund', WRG: 'Naya', WUG: 'Bant',
    WBG: 'Abzan', WUR: 'Jeskai', UBG: 'Sultai', WBR: 'Mardu', URG: 'Temur'
  };
  const ORDER = 'WUBRG';
  function colorLabel(colors) {
    const c = ORDER.split('').filter(x => colors.has(x)).join('');
    if (!c) return 'Colorless';
    if (c.length === 5) return '5 Color';
    if (c.length === 4) return '4 Color';
    return COLOR_NAMES[c] || c;
  }

  function buildSets(deck) {
    const main = new Set(), side = new Set();
    (deck.main || []).forEach(e => keysOf(e.name).forEach(k => main.add(k)));
    (deck.side || []).forEach(e => keysOf(e.name).forEach(k => side.add(k)));
    return { main, side };
  }

  function countIn(set, cards) { return cards.reduce((n, c) => n + (set.has(key(c)) ? 1 : 0), 0); }

  function test(cond, s) {
    const cards = cond.cards || [];
    const both = { has: k => s.main.has(k) || s.side.has(k) };
    switch (String(cond.type).toLowerCase()) {
      case 'inmainboard': return countIn(s.main, cards) === cards.length;
      case 'insideboard': return countIn(s.side, cards) === cards.length;
      case 'inmainorsideboard': return countIn(both, cards) === cards.length;
      case 'oneormoreinmainboard': return countIn(s.main, cards) >= 1;
      case 'oneormoreinsideboard': return countIn(s.side, cards) >= 1;
      case 'oneormoreinmainorsideboard': return countIn(both, cards) >= 1;
      case 'twoormoreinmainboard': return countIn(s.main, cards) >= 2;
      case 'twoormoreinsideboard': return countIn(s.side, cards) >= 2;
      case 'twoormoreinmainorsideboard': return countIn(both, cards) >= 2;
      case 'doesnotcontain': return countIn(both, cards) === 0;
      case 'doesnotcontainmainboard': return countIn(s.main, cards) === 0;
      case 'doesnotcontainsideboard': return countIn(s.side, cards) === 0;
      default: return false;
    }
  }

  const matches = (arch, s) => (arch.conditions || []).every(c => test(c, s));

  /**
   * deck: { main: [{name, qty}], side: [...] }
   * defs: { archetypes: [{name, includeColor, conditions, variants}], fallbacks: [{name, includeColor, commonCards}] }
   * colors: Set('W','U',...)（メインの土地以外のカードの色）
   * 戻り値: { name, base, kind: 'archetype'|'fallback'|'unknown', conflicts: [] }
   */
  function classify(deck, defs, colors) {
    const s = buildSets(deck);
    const hits = [];
    for (const a of defs.archetypes || []) {
      if (!matches(a, s)) continue;
      const v = (a.variants || []).find(v => matches(v, s));
      hits.push({ arch: v || a, base: a, specificity: (a.conditions || []).length + (v ? (v.conditions || []).length : 0) });
    }
    const label = (a) => a.includeColor ? `${colorLabel(colors || new Set())} ${a.name}` : a.name;
    if (hits.length) {
      hits.sort((x, y) => y.specificity - x.specificity);
      const top = hits[0];
      return { name: label(top.arch), base: top.base.name, kind: 'archetype', conflicts: hits.slice(1).map(h => h.base.name) };
    }
    // どの定義にも当てはまらなければ「よく使われるカード」の一致率で近いものを探す（10%以上）
    let best = null;
    for (const f of defs.fallbacks || []) {
      const cc = f.commonCards || [];
      if (!cc.length) continue;
      const ratio = countIn(s.main, cc) / cc.length;
      if (ratio >= 0.1 && (!best || ratio > best.ratio)) best = { f, ratio };
    }
    // 定義済みアーキタイプと同名の Fallback もあるので、名前で区別できるようにする
    if (best) return { name: `${label(best.f)}系（推定）`, base: best.f.name, kind: 'fallback', conflicts: [] };
    return { name: `${colorLabel(colors || new Set())} (Unknown)`, base: 'Unknown', kind: 'unknown', conflicts: [] };
  }

  return { classify, colorLabel, key };
});
