/*
 * カードの役割分類とデッキ比率の分析
 * オラクルテキストとタイプ行からのヒューリスティクス。手動で上書き可能。
 */
(function (global) {
  'use strict';

  const ROLES = [
    { id: 'land',       label: '土地',       color: '#8d7b62' },
    { id: 'ramp',       label: 'マナ加速',   color: '#3fa36b' },
    { id: 'draw',       label: 'ドロー/アド', color: '#3b82c4' },
    { id: 'removal',    label: '単体除去',   color: '#d0503c' },
    { id: 'wipe',       label: '全体除去',   color: '#9b2f2f' },
    { id: 'counter',    label: '打ち消し',   color: '#5a6fd6' },
    { id: 'tutor',      label: 'サーチ',     color: '#8a5cc7' },
    { id: 'recursion',  label: '墓地回収',   color: '#4a4a6a' },
    { id: 'protection', label: '保護',       color: '#d8b13a' },
    { id: 'threat',     label: '脅威/勝ち筋', color: '#e07a2e' },
    { id: 'other',      label: 'その他',     color: '#777' }
  ];
  const ROLE_MAP = Object.fromEntries(ROLES.map(r => [r.id, r]));
  // 主役割を決める優先順位
  const PRIORITY = ['land', 'wipe', 'removal', 'counter', 'ramp', 'draw', 'tutor', 'recursion', 'protection', 'threat', 'other'];

  const RULES = {
    ramp: [
      /\badd (\{[wubrgcs]\}|one mana|two mana|three mana|x mana|mana of any|an amount of|\{c\}\{c\})/,
      /search your library for (a|an|up to \w+|two) (basic )?(land|forest|plains|island|swamp|mountain)[^.]*?onto the battlefield/,
      /put (a|up to \w+) land cards? from your hand onto the battlefield/,
      /create (a|two|three|x) treasure tokens?/,
      /you may play (an )?additional lands?/,
      /costs? \{\d\} less to cast/
    ],
    draw: [
      /\bdraws? (a|an|one|two|three|four|five|x|that many|cards equal)\b[^.]*cards?/,
      /\bdraw (a|two|three|x) cards?/,
      /\binvestigate\b/,
      /create (a|two|three) clue tokens?/,
      /exile the top [^.]*cards? of your library[^.]*you may (play|cast)/,
      /look at the top [^.]*put [^.]*into your hand/,
      /\bconnive/
    ],
    removal: [
      /(destroy|exile) (target|another target|up to (one|two|three) target) (?!card)[^.]*?(creature|artifact|enchantment|planeswalker|permanent|battle)/,
      /deals? (\d+|x|damage equal to [^.]+) damage to (any target|target (creature|planeswalker|player or planeswalker|attacking|blocking))/,
      /deals? (\d+|x) damage divided as you choose/,
      /target creature (an opponent controls )?gets -(\d+|x)\/-(\d+|x)/,
      /\bfights? (target|another target|up to one target)/,
      /return (target|up to \w+ target) (nonland )?(creature|permanent|artifact|enchantment)[^.]*to (its|their) owner'?s'? hand/,
      /target (player|opponent) sacrifices/,
      /each opponent sacrifices (a|an) (creature|nonland|permanent)/,
      /(gain control of) target/,
      /put target [^.]*on (the )?(top|bottom) of its owner's library/,
      /tap target [^.]*\. it doesn't untap/
    ],
    wipe: [
      /(destroy|exile) all (creatures|nonland|permanents|artifacts|enchantments|other|nontoken|creatures and)/,
      /(destroy|exile) each (creature|nonland|other)/,
      /all creatures get -(\d+|x)\/-(\d+|x)/,
      /each creature gets -/,
      /deals? (\d+|x) damage to each (creature|other creature|creature and)/,
      /return all (nonland |creatures|permanents)[^.]*to (its|their) owners?'? hands?/,
      /each player sacrifices (all|that many|(a|an|two) (creature|nonland))/
    ],
    counter: [
      /\bcounter target\b/,
      /counter (it|that spell) unless/
    ],
    // 土地以外を探すサーチ（土地サーチはマナ加速側で扱う）
    tutor: [
      { test: t => (t.match(/search your library for [^.]*?cards?/g) || [])
          .some(s => !/\b(land|forest|plains|island|swamp|mountain)\b/.test(s)) }
    ],
    recursion: [
      /return [^.]*cards? from your graveyard to (your hand|the battlefield)/,
      /return [^.]*from your graveyard (to|onto)/,
      /(cast|play) [^.]*from your graveyard/,
      /\b(flashback|unearth|escape|disturb|embalm|eternalize|retrace|jump-start)\b/
    ],
    protection: [
      /(gains?|have|has) (hexproof|indestructible|shroud|protection from)/,
      /(target|creatures?|permanents?) you control (gain|have) (hexproof|indestructible|protection|shroud)/,
      /phases? out/,
      /prevent all (combat )?damage/,
      /can't be countered/
    ]
  };

  function frontType(card) {
    return String(card.typeLine || '').split('//')[0];
  }

  /** card → 役割IDの配列（自動判定） */
  function classify(card) {
    if (!card) return ['other'];
    const tl = String(card.typeLine || '');
    const front = frontType(card);
    const roles = new Set();
    if (/\bLand\b/.test(front)) {
      roles.add('land');
      return [...roles];
    }
    const text = String(card.oracle || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ');        // 注釈文を除去
    for (const [role, regs] of Object.entries(RULES)) {
      if (regs.some(r => r.test(text))) roles.add(role);
    }
    // 全体除去しか持たないカードは単体除去から外す
    if (roles.has('wipe') && /destroy all|exile all/.test(text) && !/destroy target|exile target/.test(text)) roles.delete('removal');

    const isCreature = /\bCreature\b/.test(tl);
    const isPW = /\bPlaneswalker\b/.test(tl);
    const power = parseInt(card.power, 10);
    if (isPW || /you win the game/.test(text) || /\bVehicle\b/.test(tl)) roles.add('threat');
    if (isCreature) {
      const utility = [...roles].some(r => r !== 'threat');
      if (!utility || power >= 4 || (card.keywords || []).some(k => /flying|trample|double strike|haste|infect/i.test(k)) && power >= 2) {
        roles.add('threat');
      }
    }
    if (!roles.size) roles.add('other');
    return PRIORITY.filter(r => roles.has(r));
  }

  function primary(roles) {
    return PRIORITY.find(r => roles.includes(r)) || 'other';
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

  // [min, max]。interaction = removal + wipe + counter の合算
  function targets(format, archetype) {
    if (format === 'commander') {
      return {
        ramp: [10, 14], draw: [10, 14], interaction: [10, 16], wipe: [2, 4],
        protection: [2, 6], threat: [12, 25], tutor: [0, 8]
      };
    }
    if (format === 'limited') {
      return { threat: [14, 18], interaction: [3, 8], draw: [1, 4], ramp: [0, 3], wipe: [0, 2] };
    }
    const t = {
      aggro:    { threat: [20, 30], interaction: [4, 10],  draw: [0, 4],  ramp: [0, 2],  wipe: [0, 1] },
      midrange: { threat: [12, 20], interaction: [8, 14],  draw: [3, 8],  ramp: [0, 6],  wipe: [0, 3] },
      control:  { threat: [3, 10],  interaction: [14, 22], draw: [6, 12], ramp: [0, 4],  wipe: [2, 5] },
      combo:    { threat: [2, 12],  interaction: [4, 12],  draw: [6, 14], tutor: [2, 10], protection: [2, 8] }
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

  /**
   * entries: [{qty, card, roles}]（メインデッキのみ）
   */
  /**
   * bench（任意）: 上位デッキ集計から作った目安 { targets: {role: [min,max]}, label }
   * 指定するとフォーマット別の固定目安の代わりに使う
   */
  function analyze(entries, format, archetype, bench) {
    const total = entries.reduce((s, e) => s + e.qty, 0);
    const roleCount = Object.fromEntries(ROLES.map(r => [r.id, 0]));
    const primaryCount = Object.fromEntries(ROLES.map(r => [r.id, 0]));
    const curve = [0, 0, 0, 0, 0, 0, 0, 0]; // 0..6, 7+
    const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    let nonLand = 0, mvSum = 0, cheapRampDraw = 0, lands = 0, mdfcLands = 0;

    for (const e of entries) {
      const roles = e.roles || ['other'];
      roles.forEach(r => { roleCount[r] = (roleCount[r] || 0) + e.qty; });
      primaryCount[primary(roles)] += e.qty;
      const c = e.card;
      if (!c) continue;
      const isLand = roles.includes('land');
      if (isLand) {
        lands += e.qty;
        (c.producedMana || []).forEach(col => { if (sources[col] != null) sources[col] += e.qty; });
      } else {
        nonLand += e.qty;
        mvSum += c.cmc * e.qty;
        curve[Math.min(7, Math.floor(c.cmc))] += e.qty;
        if (c.cmc <= 2 && (roles.includes('ramp') || roles.includes('draw'))) cheapRampDraw += e.qty;
        if (/\bLand\b/.test(String(c.typeLine).split('//')[1] || '')) mdfcLands += e.qty;
        // マナ加速の生産色も色源として数える（半分の重み）
        if (roles.includes('ramp')) (c.producedMana || []).forEach(col => { if (sources[col] != null) sources[col] += e.qty * 0.5; });
      }
      const front = String(c.manaCost || '').split('//')[0];
      (front.match(/\{[^}]+\}/g) || []).forEach(sym => {
        COLORS.forEach(col => { if (sym.includes(col)) pips[col] += e.qty; });
      });
    }

    const avgMV = nonLand ? mvSum / nonLand : 0;
    const recLand = recommendedLands(format, avgMV, cheapRampDraw);
    const interaction = roleCount.removal + roleCount.wipe + roleCount.counter;
    const tgt = bench ? bench.targets : targets(format, archetype);
    const size = FORMATS[format] ? FORMATS[format].size : 60;

    return {
      total, size, roleCount, primaryCount, curve, pips, sources, lands, nonLand, mdfcLands,
      avgMV, recLand, interaction, cheapRampDraw, targets: tgt,
      advice: buildAdvice({ total, size, roleCount, lands, recLand, avgMV, interaction, tgt, curve, pips, sources, format, nonLand, mdfcLands, bench })
    };
  }

  function buildAdvice(a) {
    const out = []; // {level: 'good'|'warn'|'bad'|'info', text}
    const push = (level, text) => out.push({ level, text });

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

    // 役割
    const labels = Object.fromEntries(ROLES.map(r => [r.id, r.label]));
    labels.interaction = '干渉（除去＋全体除去＋打ち消し）';
    // 上位デッキ比較のときは四分位の範囲から1枚ずれるまでは許容する
    const tol = a.bench ? 1 : 0;
    const src = a.bench ? `上位デッキ（${a.bench.label}）の中央50%` : '目安';
    for (const [key, [min, max]] of Object.entries(a.tgt)) {
      if (key === 'land' || key === 'other') continue; // 土地は上の推奨枚数で判定
      if (a.bench && max === 0 && (key === 'interaction' ? a.interaction : (a.roleCount[key] || 0)) === 0) continue; // どちらも0なら言及しない
      const v = key === 'interaction' ? a.interaction : (a.roleCount[key] || 0);
      const name = labels[key] || key;
      if (v < min - tol) push(key === 'threat' || key === 'interaction' ? 'bad' : 'warn', `${name} が ${v} 枚。${src}は ${min}〜${max} 枚だから、あと ${min - v} 枚くらい欲しいな。`);
      else if (v > max + tol) push('warn', `${name} が ${v} 枚で${src}（${min}〜${max}）より多め。他の役割に枠を回せないか考えてみよう。`);
      else if (v < min || v > max) push('info', `${name} ${v} 枚は${src}（${min}〜${max}）から1枚ずれてるけど、許容範囲かな。`);
      else push('good', `${name} ${v} 枚は${src}（${min}〜${max}）の範囲内！`);
    }

    // カーブ
    const top = a.curve[5] + a.curve[6] + a.curve[7];
    const low = a.curve[0] + a.curve[1] + a.curve[2];
    if (a.nonLand) {
      const topShare = top / a.nonLand;
      if (a.format !== 'commander' && topShare > 0.2) push('warn', `MV5以上が ${top} 枚（呪文の ${(topShare * 100).toFixed(0)}%）。序盤に動けなくなりがちだよ。`);
      if (a.format === 'commander' && topShare > 0.35) push('warn', `MV5以上が ${top} 枚。マナ加速をもう少し増やすと安定するよ。`);
      if (a.format !== 'commander' && low / a.nonLand < 0.35) push('warn', `MV2以下が ${low} 枚と少なめ。序盤の受けや展開が薄いかも。`);
    }

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

  const COLOR_JA = { W: '白', U: '青', B: '黒', R: '赤', G: '緑' };

  const api = { ROLES, ROLE_MAP, PRIORITY, FORMATS, ARCHETYPES, COLOR_JA, classify, primary, analyze, targets };
  // ブラウザでは window.Roles、Node.js（集計スクリプト）では require で使う
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Roles = api;
})(typeof window !== 'undefined' ? window : globalThis);
