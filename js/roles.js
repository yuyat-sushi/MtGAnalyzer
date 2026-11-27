/*
 * カードの役割分類とデッキ比率の分析
 * オラクルテキストとタイプ行からのヒューリスティクス。手動で上書き可能。
 */
(function (global) {
  'use strict';

  // 効果タグ（js/tags.js）。Node.js では require、ブラウザでは window.Tags
  const Tags = (typeof module !== 'undefined' && module.exports) ? require('./tags.js') : global.Tags;

  // ---------- 大カテゴリ（主な採用理由。1枚につき1つ） ----------
  const CATEGORIES = [
    { id: 'mana',     label: '土地・マナ',   color: '#8d7b62' },
    { id: 'disrupt',  label: '妨害',         color: '#d0503c' },
    { id: 'resource', label: 'リソース',     color: '#3b82c4' },
    { id: 'win',      label: '勝ち手段',     color: '#e07a2e' },
    { id: 'support',  label: '補助',         color: '#d8b13a' },
    { id: 'combo',    label: 'コンボ/展開',  color: '#2f8f8f' },
    { id: 'other',    label: 'その他',       color: '#777' }
  ];
  const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  // ---------- 小カテゴリ（1枚に複数可。大カテゴリをまたいでもよい） ----------
  const ROLES = [
    { id: 'land',       cat: 'mana',     label: '土地',         color: '#8d7b62' },
    { id: 'ramp',       cat: 'mana',     label: 'マナ加速',     color: '#3fa36b' },
    { id: 'removal',    cat: 'disrupt',  label: '単体除去',     color: '#d0503c' },
    { id: 'wipe',       cat: 'disrupt',  label: '全体除去',     color: '#9b2f2f' },
    { id: 'spell',      cat: 'disrupt',  label: '呪文への干渉', color: '#5a6fd6' },
    { id: 'ability',    cat: 'disrupt',  label: '能力への干渉', color: '#4f6470' },
    { id: 'discard',    cat: 'disrupt',  label: '手札破壊',     color: '#7a4fa0' },
    { id: 'gyhate',     cat: 'disrupt',  label: '墓地対策',     color: '#6b6b80' },
    { id: 'manalock',   cat: 'disrupt',  label: 'マナ妨害',     color: '#7a6040' },
    { id: 'combat',     cat: 'disrupt',  label: '戦闘妨害',     color: '#6e8490' },
    { id: 'draw',       cat: 'resource', label: 'ドロー',       color: '#3b82c4' },
    { id: 'tutor',      cat: 'resource', label: 'サーチ',       color: '#8a5cc7' },
    { id: 'recursion',  cat: 'resource', label: '墓地回収',     color: '#4a4a6a' },
    { id: 'selfmill',   cat: 'resource', label: '墓地肥やし',   color: '#5b6f5b' },
    { id: 'finisher',   cat: 'win',      label: 'フィニッシャー', color: '#c0392b' },
    { id: 'engine',     cat: 'win',      label: 'エンジン',     color: '#c4569a' },
    { id: 'reach',      cat: 'win',      label: '本体火力',     color: '#a8324a' },
    { id: 'tokens',     cat: 'win',      label: 'トークン展開', color: '#d98b4a' },
    { id: 'beater',     cat: 'win',      label: '打点',         color: '#e07a2e' },
    { id: 'enhance',    cat: 'support',  label: '強化',         color: '#b5835a' },
    { id: 'protection', cat: 'support',  label: '保護',         color: '#d8b13a' },
    { id: 'cheatloop',  cat: 'combo',    label: '継続的な踏み倒し', color: '#1f7f7f' },
    { id: 'cheat',      cat: 'combo',    label: '踏み倒し（1回）', color: '#2f8f8f' },
    { id: 'extraturn',  cat: 'combo',    label: '追加ターン',   color: '#3a9f9a' },
    { id: 'untap',      cat: 'combo',    label: 'アンタップ',   color: '#4aa5a0' },
    { id: 'copy',       cat: 'combo',    label: 'コピー/ストーム', color: '#5ab0a8' },
    { id: 'other',      cat: 'other',    label: 'その他',       color: '#777' }
  ];
  const ROLE_MAP = Object.fromEntries(ROLES.map(r => [r.id, r]));

  /*
   * 主な採用理由（大カテゴリ）を決める優先順位
   *   土地 ＞ 妨害 ＞ コンボ/展開 ＞ リソース ＞ マナ加速 ＞ 勝ち手段 ＞ 補助
   * 妨害に使えるカードは、打点やドローを兼ねていても主に妨害として数える（プレイヤーの感覚に合わせる）
   */
  const PRIORITY = ['land',
    'removal', 'wipe', 'spell', 'ability', 'discard', 'gyhate', 'manalock', 'combat',
    'cheatloop', 'cheat', 'extraturn', 'untap', 'copy',
    'draw', 'tutor', 'recursion', 'selfmill',
    'ramp',
    'finisher', 'engine', 'reach', 'tokens', 'beater',
    'enhance', 'protection',
    'other'];
  // 旧バージョンの役割IDの読み替え
  const LEGACY = {
    threat: 'beater', combo: 'cheat',
    // 妨害の小カテゴリを処理別（17個）から干渉する場所別（8個）にまとめたときの読み替え
    rm_exile: 'removal', rm_destroy: 'removal', rm_damage: 'removal', edict: 'removal', bounce: 'removal', steal: 'removal', neutralize: 'removal',
    landdestroy: 'manalock', counter: 'spell', redirect: 'spell', counterlock: 'spell', hate: 'spell', abilitylock: 'ability', attacklock: 'combat'
  };

  // 効果タグ → 小カテゴリ
  const EFFECT_ROLE = {
    mana: 'ramp', draw: 'draw', redirect: 'spell', discard: 'discard', attacklock: 'combat',
    tutor: 'tutor', recursion: 'recursion', selfmill: 'selfmill', protection: 'protection', gyhate: 'gyhate',
    cheat: 'cheat', extraturn: 'extraturn', untap: 'untap', copy: 'copy', drain: 'reach'
  };
  // 繰り返し起きるとき「エンジン」とみなす効果（自己強化やマナは除く）
  const ENGINE_EFFECTS = new Set(['token', 'draw', 'lifegain', 'drain', 'removal', 'energy', 'recursion', 'discard']);

  // タグでは拾いにくい、文全体で判定する追加ルール
  const EXTRA = {
    ramp: [
      /search your library for (a|an|up to [\w ]+?|two|any number of) (basic )?(land|forest|plains|island|swamp|mountain)[^.]*?onto the battlefield/,
      /put (a|up to \w+) land cards? from your hand onto the battlefield/,
      /you may play (an )?additional lands?/,
      // 他の呪文を軽くするもの（"This spell costs {1} less" のような自身の軽減は含めない）
      /\b(?<!this )spells?( you cast)?[^.]*? costs? \{\d\} less to cast/
    ],
    protection: [
      /prevent all (combat )?damage/,
      /can't be countered/
    ]
  };

  // ---------- 例外リスト（カード名で大カテゴリ・小カテゴリを指定） ----------
  let overrides = {};
  const okey = n => String(n || '').trim().toLowerCase();
  /** data/overrides.json の内容を設定する（{ "Card Name": { category, roles?, note? } }） */
  function setOverrides(obj) {
    overrides = {};
    for (const [name, v] of Object.entries(obj || {})) {
      if (name.startsWith('_') || !v) continue;
      overrides[okey(name)] = v;
    }
    cache = new WeakMap();
  }
  function overrideOf(card) {
    if (!card) return null;
    return overrides[okey(card.name)] || overrides[okey(String(card.name).split(' // ')[0])] || null;
  }

  function frontType(card) {
    return String(card.typeLine || '').split('//')[0];
  }

  let cache = new WeakMap();

  /** 小カテゴリの配列 → 主な小カテゴリ */
  function primary(roles) {
    return PRIORITY.find(r => roles.includes(r)) || 'other';
  }
  /** 小カテゴリの配列 → 大カテゴリ */
  function categoryOf(roles) {
    return ROLE_MAP[primary(roles)].cat;
  }

  /** card → { roles(小カテゴリ), cat(大カテゴリ), tags, abilities, override }（結果はカードごとにキャッシュ） */
  function inspect(card) {
    if (!card) return { roles: ['other'], cat: 'other', tags: [], abilities: [], tokens: [], speed: 'sorcery', override: null };
    if (cache.has(card)) return cache.get(card);
    const tl = String(card.typeLine || '');
    const front = frontType(card);
    let roles, tags = [], abilities = [], tokens = [], speed = 'sorcery';
    if (/\bLand\b/.test(front)) {
      roles = ['land'];
    } else {
      const t = Tags.analyze(card);
      tags = t.tags; abilities = t.abilities; tokens = t.tokens; speed = t.speed;
      const set = new Set();
      const isCreature = /\bCreature\b/.test(tl);
      t.tags.forEach(x => { if (EFFECT_ROLE[x.effect] && x.effect !== 'mana') set.add(EFFECT_ROLE[x.effect]); });
      // 妨害は「どこに干渉するか」で小カテゴリを決める（処理・形態・条件は属性として tags.detail に残す）
      const NONLAND = ['creature', 'artifact', 'enchantment', 'planeswalker', 'battle', 'player'];
      for (const x of t.tags) {
        const d = x.detail;
        if (!d) continue;
        if (x.effect === 'removal' || x.effect === 'wipe') {
          // 土地以外を巻き込めば除去、土地を巻き込めばマナ妨害（両方なら両方。Armageddon はマナ妨害だけ）
          if (d.types.some(y => NONLAND.includes(y))) set.add(x.effect === 'wipe' ? 'wipe' : 'removal');
          if (d.types.includes('land')) set.add('manalock');
          if (d.types.includes('spell')) set.add('spell');
        } else if (x.effect === 'counter') {
          if (d.types.some(y => /spell/.test(y))) set.add('spell');
          if (d.types.some(y => /ability/.test(y))) set.add('ability');
        } else if (x.effect === 'hate') {
          const ty = d.types;
          if (ty.some(y => /ability/.test(y))) set.add('ability');
          if (ty.some(y => ['spell', 'tax', 'library', 'other'].includes(y))) set.add('spell');
          if (ty.includes('mana')) set.add('manalock');
          if (ty.includes('untap')) set.add('combat');   // クリーチャーがタップ状態で出る・アンタップしない
          if (ty.includes('graveyard')) set.add('gyhate');
          if (ty.includes('attack')) set.add('combat');
        }
      }
      // 踏み倒し：起動型・誘発型・常在型で何度も使えるものは「継続的な踏み倒し」（Aether Vial、Sneak Attack、Omniscience など）
      if (t.tags.some(x => x.effect === 'cheat' && x.repeat)) {
        set.add('cheatloop');
        if (!t.tags.some(x => x.effect === 'cheat' && !x.repeat)) set.delete('cheat');
      }
      // マナ加速：クリーチャーがトークン（宝物・落とし子など）経由でマナを出すだけなら、主な役割はマナ加速ではない
      if (t.abilities.some(ab => ab.effects.includes('mana') && !(isCreature && /\btokens?\b|treasure/.test(ab.text)))) set.add('ramp');
      const text = Tags.playableOracle(card).toLowerCase().replace(/\([^)]*\)/g, ' ');
      for (const [role, regs] of Object.entries(EXTRA)) if (regs.some(r => r.test(text))) set.add(role);

      const isSpell = /\b(Instant|Sorcery)\b/.test(front);
      const power = parseInt(card.power, 10);
      // 1回きりのトークン生成は「トークン展開」（繰り返しならエンジン）
      if (t.tags.some(x => x.effect === 'token' && !x.repeat)) set.add('tokens');
      // クリーチャー以外の強化（装備品・オーラ・パンプ呪文）
      if (!isCreature && t.tags.some(x => x.effect === 'pump')) set.add('enhance');
      // エンジン：繰り返し起きる価値のある効果を持つパーマネント
      if (!isSpell && t.tags.some(x => x.repeat && x.trigger !== 'static' && ENGINE_EFFECTS.has(x.effect))) set.add('engine');
      // フィニッシャー：勝利条件、または大型の打点
      if (/you win the game/.test(text) || (isCreature && (power >= 5 || (card.cmc >= 6 && power >= 4)))) set.add('finisher');
      // 打点：本体で殴るクリーチャー（パワー3以上、回避能力つきのパワー2以上、または他に役割のないクリーチャー）
      if (isCreature || /\bVehicle\b/.test(tl)) {
        const others = [...set].filter(r => r !== 'reach' && r !== 'beater').length;
        if (power >= 3 || (power >= 2 && t.evasion) || !others) set.add('beater');
      }
      if (!set.size) set.add('other');
      roles = PRIORITY.filter(r => set.has(r));
    }
    let cat = categoryOf(roles);
    const ov = overrideOf(card);
    if (ov) {
      if (Array.isArray(ov.roles) && ov.roles.length) roles = normalizeRoles(ov.roles);
      if (ov.category && CAT_MAP[ov.category]) cat = ov.category; else cat = categoryOf(roles);
    }
    // 手札から唱えられない裏面（変身後）は別に判定して、表示だけに使う（枚数やカテゴリには数えない）
    let back = null;
    const bf = Tags.backFace(card);
    if (bf) {
      const b = inspect({ name: `${card.name}（変身後）`, typeLine: bf.typeLine, oracle: bf.oracle, keywords: [], power: null, layout: 'normal' });
      back = { roles: b.roles.filter(r => r !== 'other' && !roles.includes(r)), allRoles: b.roles, tags: b.tags, tokens: b.tokens };
    }
    const result = { roles, cat, tags, abilities, tokens, speed, override: ov, back };
    cache.set(card, result);
    return result;
  }

  // ---------- 妨害の内訳 ----------
  const DISRUPT_LABELS = {
    action: { exile: '追放', destroy: '破壊', damage: 'ダメージ', minus: 'マイナス修整', sacrifice: '生け贄（エディクト）', bounce: '手札に戻す', library: 'ライブラリーに戻す',
      steal: 'コントロール奪取', neutralize: '無力化', counter: '打ち消し', counter_exile: '打ち消し（追放）', redirect: '対象変更', discard: '捨てさせる', lock: 'ロック・封じ', other: 'その他' },
    types: { creature: 'クリーチャー', artifact: 'アーティファクト', enchantment: 'エンチャント', planeswalker: 'プレインズウォーカー', battle: 'バトル', land: '土地',
      spell: '呪文', 'noncreature spell': '非クリーチャー呪文', 'creature spell': 'クリーチャー呪文', 'instant/sorcery': 'インスタント・ソーサリー', ability: '能力',
      hand: '手札', graveyard: '墓地', player: 'プレイヤー', 'activated ability': '起動型能力', 'triggered ability': '誘発型能力',
      tax: 'コスト増加', mana: 'マナ', library: 'ライブラリー', attack: '攻撃', untap: 'アンタップ', other: 'その他' },
    targeting: { target: '対象を取る', nontarget: '対象を取らない', edict: '相手が選ぶ（エディクト）' },
    form: { once: '1回きり', ongoing: '継続（置物・常在・繰り返し）' },
    speed: { instant: 'インスタント速度', sorcery: 'ソーサリー速度', trigger: '誘発', static: '常在' }
  };

  /**
   * entries: [{qty, card}] → 妨害の内訳（カード単位の枚数）
   *   action/types/targeting/speed: その性質を持つ妨害カードの枚数（1枚が複数に数えられることもある）
   */
  function disruptProfile(entries) {
    const out = { total: 0, form: {}, action: {}, types: {}, targeting: {}, speed: {}, gives: {} };
    for (const e of entries) {
      if (!e.card) continue;
      const info = inspect(e.card);
      const ds = info.tags.filter(t => t.detail);
      if (!ds.length) continue;
      out.total += e.qty;
      const add = (bucket, keys) => new Set(keys.filter(Boolean)).forEach(k => { bucket[k] = (bucket[k] || 0) + e.qty; });
      // 形態：1回きり（呪文・出たとき）か、継続（置物・常在・繰り返し）か
      add(out.form, ds.map(t => t.repeat ? 'ongoing' : 'once'));
      add(out.action, ds.map(t => t.detail.action));
      add(out.types, ds.flatMap(t => t.detail.types));
      add(out.targeting, ds.map(t => t.detail.targeting));
      add(out.speed, ds.map(t => t.speed === 'trigger' || t.speed === 'static' ? t.speed : t.speed));
      add(out.gives, ds.map(t => t.detail.gives));
    }
    return out;
  }

  /**
   * メタゲームに対する妨害のアドバイス
   *   main / side: disruptProfile の結果、meta: ベンチマークの meta（アーキタイプごとの特徴）、group: 比較中のアーキタイプ
   *   サイドボードも含めて「対処手段があるか」を見る
   */
  function metaAdvice(main, side, meta, group) {
    const out = [];
    const push = (level, text) => out.push({ level, text });
    if (!meta || !meta.length || !main.total) return out;
    const both = k => ((main[k[0]] || {})[k[1]] || 0) + ((side[k[0]] || {})[k[1]] || 0);
    const top = list => list.sort((a, b) => b.share - a.share).slice(0, 3).map(a => `${a.name}（${Math.round(a.share * 100)}%）`).join('、');
    const shareOf = list => list.reduce((s, a) => s + a.share, 0);

    // 1. パーマネントの種類ごとの対処（サイドボード込み）
    for (const [type, label, min] of [['artifact', 'アーティファクト', 0.1], ['enchantment', 'エンチャント', 0.1], ['planeswalker', 'プレインズウォーカー', 0.08]]) {
      const heavy = meta.filter(a => a[type]);
      if (shareOf(heavy) < min) continue;
      const n = both(['types', type]);
      if (!n) push('bad', `${label}を多く使うデッキ（${top(heavy)}）が上位の${Math.round(shareOf(heavy) * 100)}%を占めてるのに、${label}に触れるカードがメインにもサイドにも0枚だよ。`);
      else if (n <= 2) push('warn', `${label}を多く使うデッキ（${top(heavy)}）が上位の${Math.round(shareOf(heavy) * 100)}%。${label}に触れるカードは${n}枚だけだから、サイドに足しておくと安心かも。`);
    }

    // 2. 墓地を使うデッキへの備え（追放除去・墓地対策）
    const gy = meta.filter(a => a.graveyard);
    if (shareOf(gy) >= 0.25) {
      const n = both(['action', 'exile']);
      if (n < 3) push(n ? 'info' : 'warn', `墓地を使うデッキ（${top(gy)}）が上位の${Math.round(shareOf(gy) * 100)}%。追放する妨害（追放除去・墓地対策）が${n}枚だけだから、破壊だと戻ってくる相手に注意してね。`);
    }

    // 3. インスタント速度のコンボへの備え（その場で止められる妨害）
    const ic = meta.filter(a => a.instantCombo && a.instantCombo.length);
    if (shareOf(ic) >= 0.05) {
      const n = both(['speed', 'instant']);
      const cards = [...new Set(ic.flatMap(a => a.instantCombo))].slice(0, 4).join('、');
      if (n < 4) push('warn', `インスタント速度のコンボ（${cards} など。${top(ic)}）が上位の${Math.round(shareOf(ic) * 100)}%。インスタント速度で動ける妨害が${n}枚だけだから、相手のターンに止める手段を確保したいな。`);
      else push('good', `インスタント速度のコンボ（${top(ic)}）に対して、インスタント速度の妨害が${n}枚あって安心。`);
    }

    // 4. 追放の比率を、比較中のアーキタイプと比べる
    if (group && group.disrupt && group.disrupt['action:exile']) {
      const med = group.disrupt['action:exile'].median;
      const v = (main.action || {}).exile || 0;
      if (med >= 2 && v < med - 1) push('info', `上位の${group.name}は追放する妨害を中央値${med}枚入れてるよ（あなたは${v}枚）。`);
    }

    // 5. 対象を取らない妨害
    if (main.total >= 6 && !((main.targeting || {}).nontarget || (main.targeting || {}).edict)) {
      push('info', '妨害がすべて対象を取るタイプだよ。呪禁や護法を持つ相手には通りにくいので、エディクトや全体除去も選択肢に入れてみて。');
    }
    return out;
  }

  /** card → 小カテゴリの配列（自動判定） */
  function classify(card) { return inspect(card).roles; }

  /** 保存済みの手動設定を現在のIDに読み替える */
  function normalizeRoles(list) {
    const ids = (list || []).map(r => LEGACY[r] || r).filter(r => ROLE_MAP[r]);
    return PRIORITY.filter(r => ids.includes(r));
  }

  // ---------- フォーマット別の目安 ----------
  const FORMATS = {
    constructed: { label: '構築 (60枚)', size: 60 },
    limited:     { label: 'リミテッド (40枚)', size: 40 },
    commander:   { label: '統率者 (100枚)', size: 100 }
  };
  const ARCHETYPES = {
    aggro: 'アグロ', midrange: 'ミッドレンジ', control: 'コントロール', combo: 'コンボ'
  };

  // [min, max]。"cat:xxx" は大カテゴリ（主な採用理由）の枚数、それ以外は小カテゴリの枚数
  function targets(format, archetype) {
    if (format === 'commander') {
      return {
        ramp: [10, 14], draw: [10, 14], 'cat:disrupt': [10, 16], wipe: [2, 4],
        protection: [2, 6], 'cat:win': [12, 25], tutor: [0, 8]
      };
    }
    if (format === 'limited') {
      return { 'cat:win': [14, 18], 'cat:disrupt': [3, 8], 'cat:resource': [1, 4], wipe: [0, 2] };
    }
    const t = {
      aggro:    { 'cat:win': [22, 32], 'cat:disrupt': [4, 10],  'cat:resource': [0, 4] },
      midrange: { 'cat:win': [12, 20], 'cat:disrupt': [8, 14],  'cat:resource': [3, 8] },
      control:  { 'cat:win': [3, 10],  'cat:disrupt': [14, 22], 'cat:resource': [6, 12], wipe: [2, 5] },
      combo:    { 'cat:combo': [4, 14], 'cat:resource': [6, 14], 'cat:disrupt': [4, 12], protection: [2, 8] }
    };
    return t[archetype] || t.midrange;
  }

  /** Frank Karsten の土地枚数式をベースにした推奨土地枚数 */
  function recommendedLands(format, avgMV, cheapRampDraw) {
    if (format === 'commander') return 31.42 + 3.13 * avgMV - 0.28 * cheapRampDraw;
    if (format === 'limited') return Math.max(15, Math.min(18, 17 + (avgMV - 3) * 1.0 - 0.2 * cheapRampDraw));
    return 19.59 + 1.90 * avgMV - 0.28 * cheapRampDraw;
  }

  const COLORS = ['W', 'U', 'B', 'R', 'G'];

  // ---- 土地サーチ（フェッチランド・土地を戦場に出すカード）----
  const LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const LAND_TYPE_JA = { Plains: '平地', Island: '島', Swamp: '沼', Mountain: '山', Forest: '森' };
  /**
   * 「ライブラリーから土地を探して戦場に出す」カードなら探せる条件を返す
   * { basic: 基本土地限定か, types: 土地タイプ指定（null なら指定なし） }
   */
  function fetchSpec(card) {
    const text = (card ? Tags.playableOracle(card) : '').replace(/\([^)]*\)/g, '');
    for (const sentence of text.split(/\.\s+|\n/)) {
      if (!/onto the battlefield/i.test(sentence)) continue;
      const m = sentence.match(/search your library for (.+?)(?:,? (?:and )?put |,? reveal|, then|\.|$)/i);
      if (!m) continue;
      const phrase = m[1];
      if (/creature|artifact|enchantment|instant|sorcery|planeswalker|nonbasic/i.test(phrase)) continue;
      const types = LAND_TYPES.filter(t => new RegExp(`\\b${t}\\b`).test(phrase));
      if (!types.length && !/\bland\b/i.test(phrase)) continue;
      return { basic: /\bbasic\b/i.test(phrase), types: types.length ? types : null };
    }
    return null;
  }
  // デッキの土地のうち spec で探せるもの
  function fetchTargets(spec, lands) {
    return lands.filter(c => {
      const t = frontType(c);
      if (spec.basic && !/\bBasic\b/.test(t)) return false;
      if (spec.types && !spec.types.some(x => new RegExp(`\\b${x}\\b`).test(t))) return false;
      return true;
    });
  }
  function fetchNeedLabel(spec) {
    const types = spec.types ? spec.types.map(t => LAND_TYPE_JA[t]).join('か') : '土地';
    return spec.basic ? (spec.types ? `基本の${types}` : '基本土地') : types;
  }

  /**
   * entries: [{qty, card, roles, cat}]（メインデッキのみ。cat を省くと roles から決める）
   */
  /**
   * bench（任意）: 上位デッキ集計から作った目安 { targets: {role: [min,max]}, label }
   * 指定するとフォーマット別の固定目安の代わりに使う
   */
  function analyze(entries, format, archetype, bench) {
    const total = entries.reduce((s, e) => s + e.qty, 0);
    const roleCount = Object.fromEntries(ROLES.map(r => [r.id, 0]));
    const catCount = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
    const curve = [0, 0, 0, 0, 0, 0, 0, 0]; // 0..6, 7+
    const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    let nonLand = 0, mvSum = 0, cheapRampDraw = 0, lands = 0, mdfcLands = 0;
    const tagCounts = {}; // "effect:r" / "effect:o"（繰り返し / 1回）→ 枚数
    const roleCards = {}; // 小カテゴリ → [{name, qty, others}]（アドバイスで兼任カードを見分ける用）
    // フェッチ対象になるデッキ内の土地（土地を戦場に出すカードの色源の計算用）
    const deckLands = entries.filter(e => e.card && /\bLand\b/.test(frontType(e.card))).map(e => e.card);
    const fetchMiss = []; // 探せる土地がデッキにないカード

    for (const e of entries) {
      const roles = e.roles || ['other'];
      roles.forEach(r => { roleCount[r] = (roleCount[r] || 0) + e.qty; });
      const cname = e.card ? (e.card.printedName || e.card.name) : (e.name || '?');
      roles.forEach(r => (roleCards[r] = roleCards[r] || []).push({ name: cname, qty: e.qty, others: roles.filter(x => x !== r) }));
      // 大カテゴリは1枚につき1つなので、合計がデッキ枚数と一致する
      catCount[e.cat || categoryOf(roles)] += e.qty;
      const c = e.card;
      if (!c) continue;
      const keys = new Set(inspect(c).tags.map(t => `${t.effect}:${t.repeat ? 'r' : 'o'}`));
      keys.forEach(k => { tagCounts[k] = (tagCounts[k] || 0) + e.qty; });
      const isLand = roles.includes('land');
      // 土地を探して戦場に出すカードは、デッキ内で探せる土地の色も色源にする
      const spec = fetchSpec(c);
      const fetchCols = new Set();
      if (spec) {
        const tg = fetchTargets(spec, deckLands.filter(x => x !== c));
        tg.forEach(x => (x.producedMana || []).forEach(col => fetchCols.add(col)));
        if (!tg.length) fetchMiss.push({ name: c.printedName || c.name, need: fetchNeedLabel(spec) });
      }
      if (isLand) {
        lands += e.qty;
        new Set([...(c.producedMana || []), ...fetchCols]).forEach(col => { if (sources[col] != null) sources[col] += e.qty; });
      } else {
        nonLand += e.qty;
        mvSum += c.cmc * e.qty;
        curve[Math.min(7, Math.floor(c.cmc))] += e.qty;
        if (c.cmc <= 2 && (roles.includes('ramp') || roles.includes('draw'))) cheapRampDraw += e.qty;
        if (/\bLand\b/.test(String(c.typeLine).split('//')[1] || '')) mdfcLands += e.qty;
        // マナ加速の生産色も色源として数える（半分の重み）
        new Set([...(roles.includes('ramp') ? (c.producedMana || []) : []), ...fetchCols]).forEach(col => { if (sources[col] != null) sources[col] += e.qty * 0.5; });
      }
      const front = String(c.manaCost || '').split('//')[0];
      (front.match(/\{[^}]+\}/g) || []).forEach(sym => {
        COLORS.forEach(col => { if (sym.includes(col)) pips[col] += e.qty; });
      });
    }

    const avgMV = nonLand ? mvSum / nonLand : 0;
    const recLand = recommendedLands(format, avgMV, cheapRampDraw);
    const tgt = bench ? bench.targets : targets(format, archetype);
    const size = FORMATS[format] ? FORMATS[format].size : 60;

    return {
      total, size, roleCount, catCount, curve, pips, sources, lands, nonLand, mdfcLands,
      avgMV, recLand, tagCounts, cheapRampDraw, targets: tgt, fetchMiss,
      advice: buildAdvice({ total, size, roleCount, roleCards, fetchMiss, catCount, lands, recLand, avgMV, tgt, curve, pips, sources, format, nonLand, mdfcLands, bench })
    };
  }

  function buildAdvice(a) {
    const out = []; // {level: 'good'|'warn'|'bad'|'info', text, group}
    // group: base（前提チェック）/ plan（メインの動き）/ meta（対策）/ extra（補足）
    let grp = 'base';
    const push = (level, text) => out.push({ level, text, group: grp });

    if (a.total === 0) {
      push('info', 'まずはカードを追加するか、MTGO形式のデッキを読み込んでね！');
      return out;
    }
    // 枚数
    if (a.format === 'commander') {
      if (a.total !== 99 && a.total !== 100) push('warn', `統率者は統率者込みで100枚ちょうどだよ（いま ${a.total} 枚）。`);
    } else if (a.total < a.size) {
      push('bad', `メインが ${a.total} 枚で、最低枚数 ${a.size} 枚に足りないよ！`);
    } else if (a.total > a.size) {
      push('warn', `メインが ${a.total} 枚。${a.size} 枚ちょうどにすると欲しいカードを引く確率が上がるよ。`);
    }
    // 土地
    const rec = Math.round(a.recLand);
    const effLands = a.lands + a.mdfcLands * 0.5;
    const diff = effLands - a.recLand;
    if (Math.abs(diff) <= 1) push('good', `土地 ${a.lands} 枚は平均MV ${a.avgMV.toFixed(2)} に対してちょうどいい感じ（目安 ${rec} 枚）。`);
    else if (diff < 0) push('bad', `土地が少なめかも…平均MV ${a.avgMV.toFixed(2)} なら目安は ${rec} 枚（いま ${a.lands} 枚${a.mdfcLands ? `＋両面土地 ${a.mdfcLands}` : ''}）。土地事故が怖いよ！`);
    else push('warn', `土地が多めかも。目安 ${rec} 枚に対して ${a.lands} 枚。マナフラッド対策に土地を減らすか、マナの使い道を足してみて。`);

    // カテゴリ（上位デッキや目安との比較。補足扱い）
    grp = 'extra';
    const labels = Object.fromEntries(ROLES.map(r => [r.id, r.label]));
    CATEGORIES.forEach(c => { labels['cat:' + c.id] = `【${c.label}】`; });
    // 小カテゴリの「多め」判定用: その役割だけを持つ専任カードで数え直す
    // 専任カードだけで上限内に収まるなら、超えた分は兼任カードのおかげなので注意しない
    function overInfo(role, limit) {
      const list = (a.roleCards && a.roleCards[role]) || [];
      if (!list.length) return null;
      const solo = list.filter(c => !c.others.length).reduce((s, c) => s + c.qty, 0);
      const multiCards = list.filter(c => c.others.length);
      const uniq = arr => [...new Set(arr)];
      return {
        warn: solo > limit || !multiCards.length,
        names: uniq(list.map(c => c.name)).join('、'),
        multi: uniq(multiCards.map(c => c.name)).join('、'),
        others: uniq(multiCards.flatMap(c => c.others).map(r => labels[r] || r)).join('・')
      };
    }
    // 上位デッキや目安との構成の違いは「参考」として淡々と出す（メタ外のカードを試す妨げにならないよう、注意にはしない）
    // 上位デッキ比較のときは四分位の範囲から1枚ずれるまでは言及しない
    const tol = a.bench ? 1 : 0;
    const src = a.bench ? `上位（${a.bench.label}）` : 'フォーマットの目安';
    for (const [key, [min, max]] of Object.entries(a.tgt)) {
      if (key === 'land' || key === 'other' || key === 'cat:mana' || key === 'cat:other') continue; // 土地は上の推奨枚数で判定
      const v = key.startsWith('cat:') ? (a.catCount[key.slice(4)] || 0) : (a.roleCount[key] || 0);
      const isCat = key.startsWith('cat:');
      if (v >= min - tol && v <= max + tol) continue;
      const name = labels[key] || key;
      const range = max === 0 ? `${src}では普段使われない役割` : `${src}（${min}〜${max} 枚）`;
      let note = '';
      if (!isCat && v > max + tol) {
        const ov = overInfo(key, max + tol);
        if (ov && !ov.warn) note = `（${ov.multi}は${ov.others}も兼ねている）`;
      }
      push('info', `${name} ${v} 枚：${range}${v < min ? 'より少なめ' : max === 0 ? '' : 'より多め'}${note}。`);
    }

    // カーブの目安も参考扱い（実際に動けるかは一人回しで見る）
    const top = a.curve[5] + a.curve[6] + a.curve[7];
    const low = a.curve[0] + a.curve[1] + a.curve[2];
    if (a.nonLand) {
      const topShare = top / a.nonLand;
      if (a.format !== 'commander' && topShare > 0.2) push('info', `MV5以上が ${top} 枚（呪文の ${(topShare * 100).toFixed(0)}%）。`);
      if (a.format === 'commander' && topShare > 0.35) push('info', `MV5以上が ${top} 枚。`);
      if (a.format !== 'commander' && low / a.nonLand < 0.35) push('info', `MV2以下が ${low} 枚（呪文の ${(low / a.nonLand * 100).toFixed(0)}%）。`);
    }

    // 土地サーチ先
    grp = 'base';
    (a.fetchMiss || []).forEach(f => push('warn', `${f.name}で探せる土地がデッキにないよ（${f.need}が必要）。`));

    // 色
    const totalPips = COLORS.reduce((s, c) => s + a.pips[c], 0);
    const totalSrc = COLORS.reduce((s, c) => s + a.sources[c], 0);
    if (totalPips && totalSrc) {
      COLORS.forEach(c => {
        if (!a.pips[c]) return;
        const pipShare = a.pips[c] / totalPips;
        const srcShare = a.sources[c] / totalSrc;
        if (srcShare + 0.12 < pipShare) {
          push('warn', `${COLOR_JA[c]}のシンボル比率 ${(pipShare * 100).toFixed(0)}% に対して、${COLOR_JA[c]}を出せる土地等が ${(srcShare * 100).toFixed(0)}% しかないよ。`);
        }
      });
    }
    return out;
  }

  // ---------- 上位デッキの脅威への対処 ----------
  const PERM_TYPES = ['creature', 'artifact', 'enchantment', 'planeswalker', 'battle'];
  const typesOfThreat = t => {
    const ty = String(t.type || '').toLowerCase();
    if (/\b(instant|sorcery)\b/.test(ty)) return ['spell'];
    return PERM_TYPES.filter(x => new RegExp(`\\b${x}\\b`).test(ty));
  };
  /**
   * card がその脅威に対処できるかと、その理由
   * threat: { type, mv, toughness }（benchmarks の meta[].threats）
   * 戻り値: { ok: true, how: 'removal'|'counter'|'discard' }
   *       | { ok: false, reason: 'type'|'damage'|'mv', note }（対処系の能力はあるが当たらない）
   *       | null（対処系の能力がない）
   */
  function answerWhy(card, threat) {
    if (!card) return null;
    const info = inspect(card);
    const tt = typesOfThreat(threat);
    if (!tt.length) return null;
    const isCreature = tt.includes('creature');
    let miss = null;
    for (const tag of info.tags) {
      const d = tag.detail;
      if (!d) continue;
      if (tag.effect === 'counter') {
        const ok = d.types.includes('spell') || (isCreature && d.types.includes('creature spell')) || (!isCreature && d.types.includes('noncreature spell')) ||
          (tt.includes('spell') && d.types.includes('instant/sorcery'));
        if (ok) return { ok: true, how: 'counter' };
        miss = miss || { ok: false, reason: 'type', note: '打ち消せる呪文の種類が違う' };
        continue;
      }
      if (tag.effect === 'discard') { if (d.types.includes('hand')) return { ok: true, how: 'discard' }; continue; }
      if (tag.effect !== 'removal' && tag.effect !== 'wipe') continue;
      const hit = d.types.filter(x => tt.includes(x));
      if (!hit.length) {
        if (d.types.some(x => PERM_TYPES.includes(x))) miss = miss || { ok: false, reason: 'type', note: '対象の種類が違う' };
        continue;
      }
      // 対処に使う能力の文（ダメージ量・マナ総量の条件を見る）
      const abil = info.abilities.find(a => (a.effects.includes('removal') || a.effects.includes('wipe')) && a.triggers.includes(tag.trigger)) || null;
      const text = abil ? abil.text : '';
      if (d.action === 'damage' && hit.length === 1 && hit[0] === 'creature') {
        const dm = text.match(/deals? (\d+) damage/);
        const tough = parseInt(threat.toughness, 10);
        if (dm && !isNaN(tough) && tough > +dm[1]) { miss = { ok: false, reason: 'damage', note: `${dm[1]}点ではタフネス${tough}に届かない` }; continue; }
      }
      // 「マナ総量N以下」。紛争などの条件で上限が上がる場合（Fatal Push）は、基本の上限で判定してメモに残す
      const allMv = [...info.abilities.filter(a => a.effects.includes('removal') || a.effects.includes('wipe')).map(a => a.text).join(' ').matchAll(/mana value (\d+) or less/g)].map(m => +m[1]);
      const mvc = text.match(/mana value (\d+) or less/);
      if (mvc && threat.mv != null && threat.mv > +mvc[1]) {
        const alt = Math.max(...allMv);
        const extra = alt > +mvc[1] && threat.mv <= alt ? `。条件を満たせば${alt}以下まで対象にできる` : '';
        miss = { ok: false, reason: 'mv', note: `マナ総量${mvc[1]}以下までしか対象にできない（${threat.mv}）${extra}` };
        continue;
      }
      return { ok: true, how: 'removal' };
    }
    return miss;
  }
  /** card がその脅威に対処できるか。{ how } か null */
  function answerOf(card, threat) {
    const r = answerWhy(card, threat);
    return r && r.ok ? { how: r.how } : null;
  }
  /**
   * 対戦相手のパーマネントの構成から見て、そのカードの妨害が「腐りやすい」か
   * perm: { creature, artifact, enchantment, planeswalker }（中央値）、graveyard: 墓地を使うデッキか
   */
  function deadAgainst(card, opp) {
    const info = inspect(card);
    const ds = info.tags.filter(t => t.detail);
    if (!ds.length) return false;
    const MIN = { creature: 4, artifact: 2, enchantment: 2, planeswalker: 1, battle: 1 };
    for (const t of ds) {
      const d = t.detail;
      // 打ち消し・手札破壊・ロック・プレイヤーに撃てるものは腐らないとみなす
      if (t.effect === 'counter' || t.effect === 'discard' || d.action === 'lock' || d.types.includes('player') || d.types.includes('land')) return false;
      if (t.effect === 'gyhate' || d.types.includes('graveyard')) { if (opp.graveyard) return false; continue; }
      if (d.types.some(x => MIN[x] != null && (opp.perm && opp.perm[x] || 0) >= MIN[x])) return false;
      if (!d.types.some(x => MIN[x] != null)) return false; // 判定できない種類は腐らない扱い
    }
    return true;
  }

  const COLOR_JA = { W: '白', U: '青', B: '黒', R: '赤', G: '緑' };

  const api = { answerOf, answerWhy, deadAgainst, CATEGORIES, CAT_MAP, ROLES, ROLE_MAP, PRIORITY, DISRUPT_LABELS, disruptProfile, metaAdvice, inspect, normalizeRoles, categoryOf, setOverrides, FORMATS, ARCHETYPES, COLOR_JA, classify, primary, analyze, targets };
  // ブラウザでは window.Roles、Node.js（集計スクリプト）では require で使う
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Roles = api;
})(typeof window !== 'undefined' ? window : globalThis);
