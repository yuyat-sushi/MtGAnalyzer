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
    tax: 'コスト増加',
    'counter:mv': 'マナ総量を指定する打ち消し（Chalice of the Void など）',
    'counter:free': 'マナを使わずに唱えた呪文の打ち消し（Vexing Bauble など）',
    'counter:colorless': '色マナを使わずに唱えた呪文の打ち消し（Void Mirror など）'
  };
  const SRC_JA = { artifact: 'アーティファクト', creature: 'クリーチャー', planeswalker: 'PW', land: '土地', permanent: 'パーマネント', any: '能力' };
  const EVT_JA = { etb: '戦場に出たとき', dies: '死亡したとき', other: 'その他' };
  /** answers の表記（"activated:artifact" "triggered:etb:creature" など）を日本語に */
  function answerLabel(a) {
    if (ANSWER_JA[a]) return ANSWER_JA[a];
    const p = a.split(':');
    if (p[0] === 'activated') return `${SRC_JA[p[1]] || p[1]}の起動型能力の封じ`;
    if (p[0] === 'triggered') return p[1] === 'other' ? '誘発型能力の打ち消し（Stifle など）' : `${SRC_JA[p[2]] || p[2] || ''}が${EVT_JA[p[1]] || p[1]}の誘発の封じ`;
    return a;
  }

  /**
   * 封じの範囲がコンボのパーツに届くか
   *   token: "activated:artifact"（アーティファクトの起動型能力）/ "triggered:etb:creature"（クリーチャーのETB誘発）/ "triggered:other"
   *   lock: { kind, sources, events }
   *   例: Null Rod（アーティファクトの起動型能力）は Goblin Charbelcher に効くが、Oops All Spells のクリーチャーの誘発には効かない
   */
  function lockCovers(token, lock) {
    const [kind, a, b] = token.split(':');
    if (kind !== lock.kind) return false;
    const src = lock.sources || [];
    if (src.includes('any')) return true;
    if (kind === 'activated') {
      const need = a;
      return src.includes(need) || src.includes('named') || src.includes('permanent') || (src.includes('nonland') && need !== 'land');
    }
    // 誘発型: 出来事（etb/dies）と、その対象（creature など）の両方が一致する必要がある
    const ev = lock.events || [];
    if (a === 'other') return false;
    return (ev.includes(a) || ev.includes('any')) && (src.includes(b) || src.includes('permanent'));
  }

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

  /** このカードの妨害の種類（answers の表記）と、能力封じの範囲 */
  function answersOf(card) {
    const out = new Set();
    out.locks = [];
    if (!card) return out;
    const info = Roles.inspect(card);
    for (const t of info.tags) {
      const d = t.detail;
      if (!d) continue;
      // 呪文を止められるものだけ「スタック」（Stifle のような能力だけの打ち消しは、能力封じの範囲として扱う）
      if (d.counterCond) out.add('counter:' + d.counterCond);   // 置物型の条件付き打ち消しは、条件に合うコンボにだけ効く
      else if (['counter', 'counter_exile'].includes(d.action) && d.types.some(x => /spell/.test(x))) out.add('stack');
      if (d.action === 'redirect') out.add('stack');
      if (d.types.includes('hand')) out.add('hand');
      if (d.types.includes('graveyard')) out.add('graveyard');
      if (d.lock) out.locks.push(...d.lock);
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
      const ans = answersOf(e.card);
      const hit = [...want].filter(a => /^(activated|triggered):/.test(a) ? ans.locks.some(l => lockCovers(a, l)) : ans.has(a));
      if (hit.length) out.push({ name: e.name, qty: e.qty, zone: e.zone, how: hit });
    }
    return out;
  }

  return { setCombos, detect, answersOf, answerCards, lockCovers, answerLabel, list: () => combos, KIND_JA, ANSWER_JA };
});
