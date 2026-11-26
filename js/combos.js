/*
 * コンボの判定
 * data/combos.json の定義（パーツのグループ＋デッキの条件）とデッキを照らし合わせ、
 * 成立しているか、何が足りないかを返す。止められる妨害（answers）とも照合する。
 * ブラウザ（window.Combos）と Node.js（require）の両方から使う。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Combos = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const Roles = (typeof module !== 'undefined' && module.exports) ? require('./roles.js') : root.Roles;

  let combos = [];
  const KIND_JA = { '即死': '即死', 'ループ': '無限ループ', 'ロック': 'ロック', '展開': '大型展開', 'リアニメイト': 'リアニメイト', '全体リアニメイト': '全体リアニメイト' };
  const ANSWER_JA = {
    stack: 'スタックで止める（打ち消しなど）', hand: '手札破壊', graveyard: '墓地対策', artifact: 'アーティファクト除去',
    enchantment: 'エンチャント除去', creature: 'クリーチャー除去', planeswalker: 'PW除去', land: '土地破壊',
    'activated ability': '起動型能力の封じ', 'triggered ability': '誘発型能力の封じ', tax: 'コスト増加'
  };

  const key = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\/\s*/g, ' // ');
  // 両面カードは表面の名前でも一致させる
  const keysOf = n => { const k = key(n); return k.includes(' // ') ? [k, k.split(' // ')[0]] : [k]; };

  function setCombos(data) {
    combos = ((data && data.combos) || data || []).filter(c => c && c.id && Array.isArray(c.pieces));
  }

  /**
   * deck: { main: [{name, qty, card?}], side: [...] }, lands: メインの土地の枚数
   * 戻り値: [{ combo, complete, missing: [グループ], reqFail: [理由], have: [カード名] }]
   *   パーツのグループの半分以上がそろっているものだけ返す
   */
  function detect(deck, lands) {
    const names = new Set();
    (deck.main || []).forEach(e => keysOf(e.name).forEach(k => names.add(k)));
    const out = [];
    for (const c of combos) {
      const groups = c.pieces.map(g => ({ g, hit: g.filter(n => names.has(key(n))) }));
      const ok = groups.filter(x => x.hit.length).length;
      if (!ok || ok < Math.ceil(groups.length / 2)) continue;
      const reqFail = [];
      if (c.requires && c.requires.maxLands != null && lands > c.requires.maxLands) {
        reqFail.push(`土地が${lands}枚（${c.requires.maxLands}枚以下で成立）`);
      }
      const missing = groups.filter(x => !x.hit.length).map(x => x.g);
      out.push({ combo: c, complete: !missing.length && !reqFail.length, missing, reqFail, have: groups.flatMap(x => x.hit) });
    }
    return out;
  }

  /** このカードの妨害が、answers のどれかに当てはまるか */
  function answersOf(card) {
    if (!card) return new Set();
    const info = Roles.inspect(card);
    const out = new Set();
    for (const t of info.tags) {
      const d = t.detail;
      if (!d) continue;
      if (['counter', 'counter_exile', 'redirect'].includes(d.action)) out.add('stack');
      if (d.types.includes('hand')) out.add('hand');
      if (d.types.includes('graveyard')) out.add('graveyard');
      if (d.types.includes('activated ability')) out.add('activated ability');
      if (d.types.includes('triggered ability')) out.add('triggered ability');
      if (d.types.includes('tax')) out.add('tax');
      if (d.action !== 'lock') {
        for (const ty of ['artifact', 'enchantment', 'creature', 'planeswalker', 'land']) if (d.types.includes(ty)) out.add(ty);
      }
    }
    return out;
  }

  /** entries（メイン＋サイド）のうち、combo を止められるカードの一覧 */
  function answerCards(entries, combo) {
    const want = new Set(combo.answers || []);
    const out = [];
    for (const e of entries) {
      const hit = [...answersOf(e.card)].filter(a => want.has(a));
      if (hit.length) out.push({ name: e.name, qty: e.qty, zone: e.zone, how: hit });
    }
    return out;
  }

  return { setCombos, detect, answersOf, answerCards, list: () => combos, KIND_JA, ANSWER_JA };
});
