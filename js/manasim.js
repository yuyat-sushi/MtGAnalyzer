/*
 * 一人回しシミュレーション（相手が何もしない前提）
 * デッキをシャッフルして1ターンずつ動かし、土地を置いて呪文を唱える。
 * ターンごとに出せるマナ、カードごとに何ターン目までに唱えられたか、
 * 何もできなかったターン、妨害を構えられたかを集計する。
 * - 土地のマナ量はテキストから読み取る（2マナ土地、Tron、神座、Cabal Coffers、条件付きのマナ）
 * - タップ状態で出る土地、バウンスランド、フェッチランド
 * - 土地サーチ（手札へ／戦場へ）、ライブラリー操作（占術・キャントリップ・上から探す）
 * - 運命を貪るもの（Devourer of Destiny）などの初手公開
 * マリガンはせず、最初の7枚をキープする前提。
 */
(function (global) {
  'use strict';

  // 効果タグ（トークンの読み取りに使う）。Node.js では require、ブラウザでは window.Tags
  const Tags = (typeof module !== 'undefined' && module.exports) ? require('./tags.js') : global.Tags;

  const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, x: 0 };
  const num = s => (s in NUM ? NUM[String(s).toLowerCase()] : (parseInt(s, 10) || 0));
  const norm = s => String(s || '').replace(/[’‘]/g, "'");
  const frontType = c => norm(c.typeLine).split('//')[0];
  // 両面カードは表面だけを見る。注釈文は除く
  const frontOracle = c => norm(c.oracle).split(/\n\/\/\n/)[0].replace(/\([^)]*\)/g, '');
  // 土地のマナ能力は注釈文（基本土地の「({T}: Add {G}.)」など）にも書かれているので括弧だけ外す
  const landOracle = c => norm(c.oracle).split(/\n\/\/\n/)[0].replace(/[()]/g, '');
  const isLandCard = c => /\bLand\b/.test(frontType(c));
  const symCount = s => (String(s).match(/\{[^}]+\}/g) || []).length;
  const genericCost = s => { const m = String(s).match(/\{(\d+)\}/); return m ? +m[1] : 0; };
  const LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

  // ---------- 土地サーチ ----------
  // 「ライブラリーから土地を探す」文を読む（相手が探すもの、土地以外を探すものは除く）
  function searchSpec(card) {
    const text = frontOracle(card);
    for (const line of text.split('\n')) {
      const m = line.match(/search your library for (.+?)(?:,? (?:and )?put |,? reveal|, then|\.|$)/i);
      if (!m) continue;
      const phrase = m[1];
      if (/creature|artifact|enchantment|instant|sorcery|planeswalker|nonbasic/i.test(phrase)) continue;
      const types = LAND_TYPES.filter(t => new RegExp(`\\b${t}\\b`).test(phrase));
      if (!types.length && !/\bland\b/i.test(phrase)) continue;
      const rest = line.slice(m.index);
      const toBf = /onto the battlefield/i.test(rest);
      const toHand = /into your hand/i.test(rest);
      if (!toBf && !toHand) continue;
      // 起動型能力ならコストを読む（Expedition Map: {2}, {T}, Sacrifice ～: Search ...）
      const pre = line.slice(0, m.index);
      const colon = pre.lastIndexOf(':');
      let ability = null;
      if (colon >= 0 && !/^\s*(When|Whenever|At)\b/i.test(pre)) {
        const cost = pre.slice(0, colon);
        if (/Sacrifice an? (?!.*\bthis\b)/i.test(cost) && !new RegExp(`Sacrifice ${escapeRe(norm(card.name))}`, 'i').test(cost) && !/Sacrifice this/i.test(cost)) {
          // 自分以外のパーマネントを生け贄に捧げる起動型能力（Knight of the Reliquaryなど）は扱わない
          continue;
        }
        ability = { cost: genericCost(cost), tap: /\{T\}/.test(cost) };
      }
      return {
        basic: /\bbasic\b/i.test(phrase),
        types: types.length ? types : null,
        dest: toBf ? 'battlefield' : 'hand',
        tapped: /onto the battlefield tapped/i.test(rest),
        alsoHand: toBf && toHand, // Cultivate など
        sacLand: /sacrifice a land/i.test(text) && !ability, // Crop Rotation
        ability
      };
    }
    return null;
  }
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---------- ライブラリー操作 ----------
  function digSpec(card) {
    const t = frontType(card);
    if (isLandCard(card)) return null;
    const text = frontOracle(card);
    const out = { draw: 0, scry: 0, dig: 0, digLand: true, scryFirst: false, cost: card.cmc || 0, reveal: 0 };
    // 初手で公開して最初のアップキープに上を見る（Devourer of Destiny）
    const rv = text.match(/reveal this card from your opening hand[\s\S]*?look at the top (\w+) cards/i);
    if (rv) out.reveal = num(rv[1]);
    if (/\bCreature\b/.test(t)) return out.reveal ? out : null;
    const cheap = (card.cmc || 0) <= 2 && /\b(Instant|Sorcery|Artifact)\b/.test(t);
    if (!cheap) return out.reveal ? out : null;
    let firstScry = -1, firstDraw = -1;
    for (const line of text.split('\n')) {
      // 起動型能力の追加コスト（Relic of Progenitus など）。マナを出す能力なら差し引きゼロ
      const colon = line.indexOf(':');
      const actCost = colon > 0 && /\{/.test(line.slice(0, colon)) && !/\bAdd\b/.test(line) ? genericCost(line.slice(0, colon)) : 0;
      const dm = line.match(/(?:^|[.:,]\s*|then )draw (a|one|two|three) cards?/i);
      if (dm && !/(target|each) (player|opponent)|opponent draws/i.test(line)) {
        out.draw += num(dm[1]); out.cost += actCost;
        if (firstDraw < 0) firstDraw = text.indexOf(dm[0]);
      }
      const sm = line.match(/\b(?:Scry|Surveil) (\d+)/i);
      if (sm) { out.scry = Math.max(out.scry, +sm[1]); if (firstScry < 0) firstScry = text.indexOf(sm[0]); }
      if (/look at the top card of your library\. You may put (?:it|that card) into your graveyard/i.test(line)) {
        out.scry = Math.max(out.scry, 1); if (firstScry < 0) firstScry = text.indexOf('look at the top card');
      }
      const lk = line.match(/look at the top (\w+) cards of your library/i);
      if (lk) {
        const n = num(lk[1]);
        if (/into your hand/i.test(line)) {
          out.dig = Math.max(out.dig, n);
          const f = (line.match(/reveal an? (.+?) card from among/i) || [])[1] || '';
          out.digLand = !f || /land|colorless|permanent/i.test(f) || !/creature|instant|sorcery|artifact|enchantment|noncreature/i.test(f);
        } else if (/put them back in any order|on the bottom|into your graveyard/i.test(line)) {
          out.scry = Math.max(out.scry, n); if (firstScry < 0) firstScry = text.indexOf(lk[0]);
        }
      }
    }
    out.scryFirst = firstScry >= 0 && (firstDraw < 0 || firstScry < firstDraw);
    if (!out.draw && !out.scry && !out.dig && !out.reveal) return null;
    return out;
  }

  // ---------- 土地のマナ ----------
  function landProfile(card) {
    const text = landOracle(card);
    const typeStr = frontType(card);
    const p = {
      name: card.name, typeStr, every: /is every nonbasic land type/i.test(text),
      base: 0, tron: null, count: null, cond: null, tapped: 'no', bounce: false, fetch: null
    };
    for (const line of text.split('\n')) {
      const ci = line.indexOf(': Add ');
      if (ci < 0) continue;
      const cost = line.slice(0, ci);
      if (/Sacrifice/i.test(cost)) continue; // 1回きりの能力（Crystal Vein の2マナ）は数えない
      const gc = genericCost(cost);
      const body = line.slice(ci + 2);
      const first = body.split(/\.\s/)[0];
      const cnt = first.match(/Add (\{[^}]+\}) for each (\w+)(?: on the battlefield| you control)/);
      if (cnt) {
        if (/^[A-Z]/.test(cnt[2])) p.count = { type: cnt[2], cost: gc }; // 土地タイプ（Locus、Swamp）
        else p.base = Math.max(p.base, 1); // クリーチャーの数などは追跡しないので1マナ
        continue;
      }
      let amt = symCount(first.split(/ or /)[0].replace(/^Add /, ''));
      const word = first.match(/Add (one|two|three) mana/i);
      if (word) amt = num(word[1]);
      if (/Add an amount of mana/i.test(first)) amt = 1;
      amt = Math.max(0, amt - gc);
      const only = body.match(/Spend this mana only to cast (.+?) spells/i);
      if (only) {
        const kw = only[1].split(/\s+/).filter(w => !/^(colorless|or|and|a|an)$/i.test(w));
        if (!p.cond || amt > p.cond.amt) p.cond = { amt, kw };
      } else p.base = Math.max(p.base, amt);
      const tr = body.match(/If you control an? (.+?) and an? (.+?), add ((?:\{C\})+) instead/i);
      if (tr) p.tron = { needs: [tr[1], tr[2]], amt: symCount(tr[3]) };
    }
    // タップ状態で出るか
    for (const s of text.split(/\.\s+|\n/)) {
      const m = s.match(/\benters(?: the battlefield)? tapped\b(.*)$/i);
      if (!m || /onto the battlefield/i.test(s)) continue;
      if (/^\s*If you don't/i.test(s)) { p.tapped = 'no'; break; } // ショックランドはライフを払う
      const u = m[1];
      if (!/unless/i.test(u)) { p.tapped = 'yes'; break; }
      let r;
      if ((r = u.match(/unless you control (\w+) or fewer other lands/i))) p.tapped = { fewer: num(r[1]) };
      else if ((r = u.match(/unless you control (\w+) or more other lands/i))) p.tapped = { more: num(r[1]) };
      else if ((r = u.match(/unless you control an? (\w+)(?: or an? (\w+))?/i))) p.tapped = { types: [r[1], r[2]].filter(Boolean) };
      else p.tapped = 'no'; // 手札を公開するなどの条件は満たせるものとする
      break;
    }
    p.colors = (card.producedMana || []).filter(x => /^[WUBRGC]$/.test(x));
    if (!p.colors.length) p.colors = ['C'];
    p.bounce = /return a land you control to its owner's hand/i.test(text);
    const sp = searchSpec(card);
    if (sp && sp.dest === 'battlefield') p.fetch = sp;
    return p;
  }

  const hasType = (bf, type) => bf.some(l => l.p.every || l.p.typeStr.includes(type));
  // 土地1枚が出せるマナ（Tron・タイプの数・条件付きを含む）
  function landMana(p, bf, slot) {
    let m = p.base;
    if (p.tron && p.tron.needs.every(n => hasType(bf, n))) m = Math.max(m, p.tron.amt);
    if (p.count) {
      const n = bf.filter(l => l.p.every || l.p.typeStr.includes(p.count.type)).length;
      m = Math.max(m, n - p.count.cost);
    }
    if (p.cond && slot && slot.condOn) m = Math.max(m, p.cond.amt);
    return m;
  }
  // 戦場の土地のうち、このターン使えるものから出せるマナの合計
  function manaOf(bf) {
    let total = 0;
    for (const l of bf) if (!l.sick) total += landMana(l.p, bf, l);
    return total;
  }
  function entersTapped(p, bf) {
    if (p.tapped === 'yes') return true;
    if (p.tapped === 'no') return false;
    if (p.tapped.fewer != null) return bf.length > p.tapped.fewer;
    if (p.tapped.more != null) return bf.length < p.tapped.more;
    if (p.tapped.types) return !p.tapped.types.some(t => hasType(bf, t));
    return false;
  }

  // ---------- マナコスト ----------
  // {2}{G}{G} → { generic: 2, pips: {G: 2} }。混成・ファイレクシアは不特定1、Xは0
  function costOf(card) {
    const mc = String(card.manaCost || '').split('//')[0];
    const out = { generic: 0, pips: {} };
    const syms = mc.match(/\{[^}]+\}/g) || [];
    if (!syms.length) { out.generic = Math.round(card.cmc || 0); return out; }
    for (const s of syms) {
      const x = s.slice(1, -1);
      if (/^\d+$/.test(x)) out.generic += +x;
      else if (/^[WUBRG]$/.test(x)) out.pips[x] = (out.pips[x] || 0) + 1;
      else if (/\/P$/.test(x)) continue; // ファイレクシアマナはライフで払う
      else if (x === 'X' || x === 'Y') continue;
      else out.generic += 1; // 混成・{C}・{S}
    }
    return out;
  }
  const addGeneric = (cost, n) => ({ generic: cost.generic + n, pips: cost.pips });
  const GENERIC = n => ({ generic: n, pips: {} });

  // マナを出すクリーチャー・アーティファクト（{T}: Add ...。生け贄にするものは除く）
  function rockSpec(card) {
    if (isLandCard(card)) return null;
    const text = landOracle(card);
    let best = 0;
    for (const line of text.split('\n')) {
      const ci = line.indexOf(': Add ');
      if (ci < 0) continue;
      const cost = line.slice(0, ci);
      if (!/\{T\}/.test(cost) || /Sacrifice|Exile|Discard|Remove/i.test(cost)) continue;
      const first = line.slice(ci + 2).split(/\.\s/)[0];
      if (/for each|an amount/i.test(first)) { best = Math.max(best, 1); continue; }
      let amt = symCount(first.split(/ or /)[0].replace(/^Add /, ''));
      const w = first.match(/Add (one|two|three) mana/i);
      if (w) amt = num(w[1]);
      best = Math.max(best, amt - genericCost(cost));
    }
    if (best <= 0) return null;
    const colors = (card.producedMana || []).filter(x => /^[WUBRGC]$/.test(x));
    return { amt: best, colors: colors.length ? colors : ['C'], creature: /\bCreature\b/.test(frontType(card)) };
  }

  // ---------- 乱数（デッキが同じなら結果も同じになるように固定シード） ----------
  function rngFrom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }

  // ---------- デッキの下準備 ----------
  // entries: [{qty, card, cat?, key?}]
  function prepare(entries, keyNames) {
    const cards = [];
    const keySet = new Set(keyNames || []);
    for (const e of entries) {
      const c = e.card;
      if (!c) continue;
      const land = isLandCard(c);
      const info = {
        name: c.name, card: c, land,
        p: land ? landProfile(c) : null,
        search: land ? null : searchSpec(c),
        dig: land ? null : digSpec(c),
        rock: land ? null : rockSpec(c),
        creature: /\bCreature\b/.test(frontType(c)),
        cost: land ? GENERIC(0) : costOf(c),
        cmc: c.cmc || 0,
        cat: e.cat || null,
        key: keySet.has(c.name),
        perm: land ? null : permOf(c)
      };
      // 構える妨害は、唱えて終わるインスタント・ソーサリーだけ。妨害のパーマネント（Karn、Teferi、Thalia など）は唱えて盤面に置く
      info.disrupt = !info.key && info.cat === 'disrupt' && /\b(Instant|Sorcery)\b/.test(frontType(c));
      for (let i = 0; i < e.qty; i++) cards.push(info);
    }
    const lands = cards.filter(x => x.land);
    const spells = cards.filter(x => !x.land);
    // 条件付きのマナ（Eldrazi Temple など）は対象の呪文の割合で使えるものとする
    const ratioCache = {};
    const ratio = kw => {
      const key = kw.join(' ');
      if (!(key in ratioCache)) {
        const ok = spells.filter(s => kw.every(w => new RegExp(`\\b${escapeRe(w)}`, 'i').test(frontType(s.card)))).length;
        ratioCache[key] = spells.length ? ok / spells.length : 0;
      }
      return ratioCache[key];
    };
    const tronTypes = [...new Set(lands.filter(l => l.p.tron).flatMap(l => [...l.p.tron.needs, tronOwnType(l.p)]).filter(Boolean))];
    return { cards, lands, ratio, tronTypes };
  }
  // 盤面に残るパーマネントの情報（クリーチャーのパワー・タフネス、出たときと毎ターンのトークン）
  const nk = n => String(n || '').split(' // ')[0].toLowerCase();
  function ptOf(s) { const n = parseInt(s, 10); return isNaN(n) ? 0 : n; }
  function permOf(c) {
    const front = frontType(c);
    if (/\b(Instant|Sorcery)\b/.test(front)) {
      return { types: [], etbTokens: spellTokens(c), turnTokens: [] };
    }
    const types = ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'].filter(t => new RegExp(`\\b${t}\\b`).test(front)).map(t => t.toLowerCase());
    const out = { types, power: ptOf(c.power), toughness: ptOf(c.toughness), etbTokens: [], turnTokens: [] };
    if (Tags) {
      const a = Tags.analyze(c);
      a.abilities.forEach(ab => {
        if (!ab.tokens || !ab.tokens.length) return;
        const toks = ab.tokens.filter(k => k.who === 'self' && k.kind === 'creature').map(k => {
          const [pw, th] = String(k.pt || '1/1').split('/');
          return { power: ptOf(pw), toughness: ptOf(th) || 1 };
        });
        if (!toks.length) return;
        if (ab.triggers.some(t => t === 'etb' || t === 'spell')) out.etbTokens.push(...toks);
        else if (ab.triggers.some(t => ['each_turn', 'attack', 'combat_damage', 'creature_enters', 'landfall', 'cast_trigger', 'lifegain_trigger', 'other_trigger'].includes(t))) out.turnTokens.push(...toks);
      });
    }
    return out;
  }
  function spellTokens(c) {
    if (!Tags) return [];
    return Tags.analyze(c).abilities.flatMap(ab => (ab.tokens || []).filter(k => k.who === 'self' && k.kind === 'creature').map(k => {
      const [pw, th] = String(k.pt || '1/1').split('/');
      return { power: ptOf(pw), toughness: ptOf(th) || 1 };
    }));
  }
  function tronOwnType(p) {
    const m = p.typeStr.match(/—\s*(.+)$/);
    return m ? m[1].trim() : null;
  }

  // ---------- 1ゲーム ----------
  function playGame(deck, onPlay, turns, rng) {
    const lib = shuffle(deck.cards.slice(), rng);
    const hand = lib.splice(0, 7);
    const bf = [];    // 土地 {p, sick, card, used, condOn}
    const rocks = []; // マナを出すパーマネント {amt, colors, sick, used}
    const perms = []; // 起動型のサーチを持つパーマネント（Expedition Map など）
    const tron = deck.tronTypes;
    const g = { mana: [], idle: [], unused: [], held: [], inHand: [], cast: {}, seen: {}, board: [], combo: [] };
    // 盤面（土地以外）: クリーチャー {power, toughness}、それ以外のパーマネントの数、毎ターン出るトークン
    const board = { creatures: [], artifact: 0, enchantment: 0, planeswalker: 0, battle: 0, makers: [] };
    const seenNames = new Set();
    const addPerm = c => {
      const pm = c.perm;
      if (!pm) return;
      pm.etbTokens.forEach(t => board.creatures.push({ ...t }));
      if (!pm.types.length) return;
      if (pm.types.includes('creature')) board.creatures.push({ power: pm.power, toughness: pm.toughness });
      ['artifact', 'enchantment', 'planeswalker', 'battle'].forEach(t => { if (pm.types.includes(t) && !pm.types.includes('creature')) board[t]++; });
      if (pm.turnTokens.length) board.makers.push(pm.turnTokens);
    }; // cast/seen: 名前 → 最初に唱えた／手札にあったターン
    let floated = null; // バウンスランドで戻す前に出したマナ {amt, colors, used}
    let landDrop = true, castThisTurn = 0, turn = 0, otherSpent = 0;

    const landsInHand = () => hand.filter(c => c.land).length;
    const missingTron = () => tron.filter(t => !bf.some(l => l.p.every || l.p.typeStr.includes(t)) && !hand.some(c => c.land && (c.p.every || c.p.typeStr.includes(t))));
    const missingOnBf = () => tron.filter(t => !bf.some(l => l.p.every || l.p.typeStr.includes(t)));
    const value = c => {
      if (c.land) {
        if (tron.length && missingTron().some(t => c.p.every || c.p.typeStr.includes(t))) return 3;
        const n = landsInHand();
        return n === 0 ? 2 : n === 1 ? 1 : 0.4;
      }
      if (c.key) return 1.5;
      if (c.search) return landsInHand() === 0 || (tron.length && missingTron().length) ? 1.2 : 0.6;
      return landsInHand() === 0 ? 0.3 : 0.5;
    };

    // ---- マナの支払い ----
    const sources = () => {
      const out = [];
      bf.forEach(l => { if (!l.sick) out.push({ ref: l, amt: landMana(l.p, bf, l) - l.used, colors: l.p.colors }); });
      rocks.forEach(r => { if (!r.sick) out.push({ ref: r, amt: r.amt - r.used, colors: r.colors }); });
      if (floated) out.push({ ref: floated, amt: floated.amt - floated.used, colors: ['W', 'U', 'B', 'R', 'G'] });
      return out.filter(s => s.amt > 0);
    };
    const avail = () => sources().reduce((s, x) => s + x.amt, 0);
    // 色の支払い方を決める（色の少ない発生源から使う）。払えなければ null
    const plan = cost => {
      const src = sources().map(s => ({ ...s }));
      const use = new Map();
      const take = (s, n) => { s.amt -= n; use.set(s.ref, (use.get(s.ref) || 0) + n); };
      for (const [col, n] of Object.entries(cost.pips)) {
        for (let i = 0; i < n; i++) {
          const s = src.filter(x => x.amt > 0 && x.colors.includes(col)).sort((a, b) => a.colors.length - b.colors.length)[0];
          if (!s) return null;
          take(s, 1);
        }
      }
      let rest = cost.generic;
      for (const s of src.sort((a, b) => a.colors.length - b.colors.length)) {
        if (rest <= 0) break;
        const n = Math.min(s.amt, rest);
        if (n > 0) { take(s, n); rest -= n; }
      }
      return rest > 0 ? null : use;
    };
    const pay = cost => {
      const use = plan(cost);
      if (!use) return false;
      use.forEach((n, ref) => { ref.used += n; });
      return true;
    };

    // ---- ライブラリー操作 ----
    const scry = n => {
      const top = lib.splice(0, Math.min(n, lib.length));
      const keep = top.filter(c => value(c) >= 0.5).sort((a, b) => value(b) - value(a));
      const drop = top.filter(c => value(c) < 0.5);
      lib.unshift(...keep); lib.push(...drop);
    };
    const draw = n => { for (let i = 0; i < n && lib.length; i++) hand.push(lib.shift()); };
    const dig = (n, landOk) => {
      const top = lib.splice(0, Math.min(n, lib.length));
      let best = -1, bv = -1;
      top.forEach((c, i) => { if ((c.land && landOk) || !c.land) { const v = value(c); if (v > bv) { bv = v; best = i; } } });
      if (best >= 0) hand.push(top.splice(best, 1)[0]);
      lib.push(...top);
    };
    const matches = (spec, c) => c.land && (!spec.basic || /\bBasic\b/.test(c.p.typeStr)) && (!spec.types || spec.types.some(t => c.p.typeStr.includes(t)));
    // サーチ先を選ぶ（足りないTronパーツ → このターン・次のターンのマナが一番増える土地）
    const pickTarget = (spec, dest) => {
      let best = -1, bv = -Infinity;
      const miss = tron.length ? missingTron() : [];
      lib.forEach((c, i) => {
        if (!matches(spec, c)) return;
        let v = miss.some(t => c.p.every || c.p.typeStr.includes(t)) ? 100 : 0;
        const test = bf.concat([{ p: c.p, sick: dest === 'battlefield' && (spec.tapped || entersTapped(c.p, bf)) }]);
        v += manaOf(test) + manaOf(test.map(l => ({ p: l.p })));
        if (v > bv) { bv = v; best = i; }
      });
      return best;
    };
    const takeFromLib = i => { const c = lib.splice(i, 1)[0]; shuffle(lib, rng); return c; };
    const newSlot = (c, sick) => ({ p: c.p, sick, card: c, used: 0, condOn: !!(c.p.cond && rng() < deck.ratio(c.p.cond.kw)) });

    // ---- 土地 ----
    const putLand = c => {
      const tapped = entersTapped(c.p, bf);
      if (c.p.fetch) {
        const i = pickTarget(c.p.fetch, 'battlefield');
        if (i >= 0) { const t = takeFromLib(i); bf.push(newSlot(t, c.p.fetch.tapped || entersTapped(t.p, bf) || tapped)); return; }
      }
      const slot = newSlot(c, tapped);
      bf.push(slot);
      if (c.p.bounce) {
        // 一番マナの少ない土地（なければ自分）を手札に戻す。戻す前にマナを出しておく
        let ri = -1, rv = Infinity;
        bf.forEach((l, i) => {
          if (l === slot || l.p.bounce) return;
          const v = landMana(l.p, bf, l) + (tron.length && tron.some(t => l.p.typeStr.includes(t)) ? 5 : 0);
          if (v < rv) { rv = v; ri = i; }
        });
        const back = ri >= 0 ? bf.splice(ri, 1)[0] : bf.splice(bf.indexOf(slot), 1)[0];
        if (!back.sick && back !== slot) {
          const left = landMana(back.p, bf.concat([back]), back) - back.used;
          if (left > 0) floated = { amt: (floated ? floated.amt - floated.used : 0) + left, used: 0 };
        }
        hand.push(back.card);
      }
    };
    // 置く土地の点数 = このターンのマナ（重み w）＋ 次のターンのマナ
    const scoreLand = c => {
      const tapped = entersTapped(c.p, bf);
      const test = bf.concat([{ p: c.p, sick: tapped }]);
      if (c.p.fetch) {
        const i = pickTarget(c.p.fetch, 'battlefield');
        if (i < 0) return -1;
        const tg = lib[i];
        test[test.length - 1] = { p: tg.p, sick: c.p.fetch.tapped || entersTapped(tg.p, bf) };
      }
      // このターンに使う予定のマナがなければ、タップインを先に置いてよい
      const want = hand.some(x => !x.land && !x.disrupt && x.cmc <= manaOf(bf) + 1 && x.cmc > 0);
      const w = turn === 1 && !want ? 0 : 1;
      let now = manaOf(test), next = manaOf(test.map(l => ({ p: l.p })));
      if (c.p.bounce) {
        if (!bf.length) return -1;
        now = manaOf(bf);
        next -= Math.min(...bf.map(l => landMana(l.p, bf, l)));
        next += 1;
      }
      const miss = missingOnBf();
      const tronBonus = miss.length && miss.some(x => c.p.every || c.p.typeStr.includes(x)) ? 0.5 : 0;
      return now * w + next + tronBonus + (tapped || c.p.bounce ? 0.01 : 0);
    };
    const playLand = () => {
      if (!landDrop) return false;
      const ls = hand.filter(c => c.land);
      if (!ls.length) return false;
      let best = ls[0], bs = -Infinity;
      ls.forEach(c => { const s = scoreLand(c); if (s > bs) { bs = s; best = c; } });
      hand.splice(hand.indexOf(best), 1);
      putLand(best);
      landDrop = false;
      return true;
    };

    // ---- 呪文 ----
    const useful = spec => {
      const miss = tron.length ? missingTron() : [];
      if (miss.length && lib.some(c => matches(spec, c) && miss.some(t => c.p.every || c.p.typeStr.includes(t)))) return true;
      if (spec.sacLand) return false; // 入れ替えは足りないTronパーツのためだけに使う
      if (spec.dest === 'battlefield') return lib.some(c => matches(spec, c));
      return landsInHand() === 0 && landDrop && lib.some(c => matches(spec, c));
    };
    const doSearch = spec => {
      const i = pickTarget(spec, spec.dest);
      if (i < 0) return;
      const c = takeFromLib(i);
      if (spec.dest === 'battlefield') {
        if (spec.sacLand) {
          let si = -1, sv = Infinity;
          bf.forEach((l, k) => { const v = landMana(l.p, bf, l) + (tron.some(t => l.p.typeStr.includes(t)) ? 5 : 0); if (v < sv) { sv = v; si = k; } });
          if (si >= 0) bf.splice(si, 1);
        }
        bf.push(newSlot(c, spec.tapped || entersTapped(c.p, bf)));
        if (spec.alsoHand) { const j = pickTarget(spec, 'hand'); if (j >= 0) hand.push(takeFromLib(j)); }
      } else hand.push(c);
    };
    const record = c => {
      castThisTurn++;
      if (!(c.name in g.seen)) g.seen[c.name] = turn;
      if (!(c.name in g.cast)) g.cast[c.name] = turn;
    };
    const castFromHand = c => {
      if (!pay(c.cost)) return false;
      hand.splice(hand.indexOf(c), 1);
      record(c);
      // 使い捨てのキャントリップ（Chromatic Star など）と、起動して生け贄にするサーチは盤面に残さない
      if (!(c.dig && /\bArtifact\b/.test(frontType(c.card))) && !(c.search && c.search.ability)) addPerm(c);
      return true;
    };
    const canPay = cost => !!plan(cost);
    // 1回分の行動。何かしたら true
    const step = (lateCantrips) => {
      // 1. 戦場にあるサーチの起動（Expedition Map など）
      const pi = perms.findIndex(x => x.ready && useful(x.spec) && canPay(GENERIC(x.spec.ability.cost)));
      if (pi >= 0) { const x = perms.splice(pi, 1)[0]; pay(GENERIC(x.spec.ability.cost)); castThisTurn++; doSearch(x.spec); return true; }
      // 2. 手札の土地サーチ
      const sc = hand.find(c => c.search && useful(c.search) && canPay(c.cost));
      if (sc) {
        castFromHand(sc);
        if (sc.search.ability) {
          const x = { spec: sc.search, ready: !(sc.search.ability.tap && sc.creature) };
          if (x.ready && pay(GENERIC(sc.search.ability.cost))) doSearch(sc.search);
          else perms.push(x);
        } else doSearch(sc.search);
        return true;
      }
      // 3. マナを出すパーマネント
      const rc = hand.find(c => c.rock && canPay(c.cost));
      if (rc) { castFromHand(rc); rocks.push({ amt: rc.rock.amt, colors: rc.rock.colors, sick: rc.rock.creature, used: 0 }); return true; }
      // 4. 土地がないときの占術・キャントリップ
      const digs = hand.filter(c => c.dig && !c.search && (c.dig.draw || c.dig.scry || c.dig.dig) && canPay(c.cost));
      const castDig = c => {
        castFromHand(c);
        const d = c.dig;
        if (d.scryFirst) { scry(d.scry); draw(d.draw); } else { draw(d.draw); if (d.scry) scry(d.scry); }
        if (d.dig) dig(d.dig, d.digLand);
        return true;
      };
      if (!landsInHand() && landDrop && digs.length) return castDig(digs[0]);
      // 5. 主力 → それ以外（妨害は構えるので唱えない）。重いものから唱えてマナを使い切る
      const spells = hand.filter(c => !c.land && !c.disrupt && !c.rock && !c.search && !c.dig && canPay(c.cost));
      if (spells.length) {
        spells.sort((a, b) => (b.key - a.key) || (b.cmc - a.cmc));
        const c = spells[0];
        const before = avail();
        castFromHand(c);
        if (!c.key) otherSpent += before - avail();
        return true;
      }
      // 6. 余ったマナで占術・キャントリップ
      if (lateCantrips && digs.length) return castDig(digs[0]);
      return false;
    };
    const act = late => { for (let guard = 0; guard < 20 && step(late); guard++); };

    // 初手公開（Devourer of Destiny）: 最初のアップキープに上 n 枚から1枚だけ上に残す
    hand.filter(c => c.dig && c.dig.reveal).forEach(c => {
      const top = lib.splice(0, Math.min(c.dig.reveal, lib.length));
      if (!top.length) return;
      top.sort((a, b) => value(b) - value(a));
      lib.unshift(top[0]); // 残りは追放
    });

    for (turn = 1; turn <= turns; turn++) {
      bf.forEach(l => { l.sick = false; l.used = 0; l.condOn = !!(l.p.cond && rng() < deck.ratio(l.p.cond.kw)); });
      rocks.forEach(r => { r.sick = false; r.used = 0; });
      perms.forEach(x => { x.ready = true; });
      floated = null; landDrop = true; castThisTurn = 0; otherSpent = 0;
      // 毎ターン（攻撃時・終了時など）トークンを出すパーマネントは、1ターンに1回出したものとして近似
      board.makers.forEach(list => list.forEach(t => board.creatures.push({ ...t })));
      if (!(onPlay && turn === 1)) draw(1);
      if (!landsInHand()) act(false); // 土地がなければ先に探す
      playLand();
      act(false);
      if (playLand()) act(false);
      act(true);
      // 集計: 出せるマナ（使った分も含む）、何もできなかったか、使い残し、妨害を構えられたか
      const total = manaOf(bf) + rocks.reduce((s, r) => s + (r.sick ? 0 : r.amt), 0) + (floated ? floated.amt : 0);
      const left = avail();
      // 主力以外の呪文を我慢すれば構えられたか（使ったマナを好きな色で戻して判定する近似）
      if (otherSpent) floated = { amt: (floated ? floated.amt - floated.used : 0) + otherSpent, used: 0 };
      const held = hand.some(c => c.disrupt && canPay(c.cost));
      if (otherSpent) { floated.amt -= otherSpent; if (floated.amt <= 0) floated = null; }
      hand.forEach(c => { if (!c.land && !(c.name in g.seen)) g.seen[c.name] = turn; });
      hand.forEach(c => seenNames.add(nk(c.name)));
      Object.keys(g.cast).forEach(n => seenNames.add(nk(n)));
      bf.forEach(l => l.card && seenNames.add(nk(l.card.name)));
      const cr = board.creatures;
      g.board.push({
        creatures: cr.length, power: cr.reduce((s, x) => s + x.power, 0), toughness: cr.reduce((s, x) => s + x.toughness, 0),
        t1: cr.filter(x => x.toughness <= 1).length, t2: cr.filter(x => x.toughness <= 2).length, t3: cr.filter(x => x.toughness <= 3).length,
        artifact: board.artifact, enchantment: board.enchantment, planeswalker: board.planeswalker
      });
      g.combo.push((deck.combos || []).some(cb => cb.pieces.every(gr => gr.some(n => seenNames.has(nk(n))))));
      g.mana.push(total);
      g.unused.push(held ? 0 : left);
      g.held.push(held);
      g.inHand.push(hand.some(c => c.disrupt));
      g.idle.push(castThisTurn === 0 && !held);
    }
    return g;
  }

  function run(deck, onPlay, turns, iters, seed, keyNames) {
    const rng = rngFrom(seed);
    const sum = Array(turns).fill(0), unused = Array(turns).fill(0), idle = Array(turns).fill(0), held = Array(turns).fill(0), inHand = Array(turns).fill(0), keyBy = Array(turns).fill(0);
    const ge = Array.from({ length: turns }, () => Array(12).fill(0));
    const castBy = {}, seenBy = {};
    const BK = ['creatures', 'power', 'toughness', 't1', 't2', 't3', 'artifact', 'enchantment', 'planeswalker'];
    const board = Array.from({ length: turns }, () => Object.fromEntries(BK.map(k => [k, 0])));
    const wide = Array(turns).fill(0), combo = Array(turns).fill(0);
    const keys = new Set(keyNames);
    for (let n = 0; n < iters; n++) {
      const r = playGame(deck, onPlay, turns, rng);
      r.mana.forEach((m, t) => { sum[t] += m; for (let k = 0; k <= Math.min(11, m); k++) ge[t][k]++; });
      r.unused.forEach((m, t) => { unused[t] += m; });
      r.idle.forEach((x, t) => { if (x) idle[t]++; });
      r.held.forEach((x, t) => { if (x) held[t]++; });
      r.inHand.forEach((x, t) => { if (x) inHand[t]++; });
      r.board.forEach((b, t) => { BK.forEach(k => { board[t][k] += b[k]; }); if (b.creatures >= 3) wide[t]++; });
      r.combo.forEach((x, t) => { if (x) combo[t]++; });
      for (const [name, t] of Object.entries(r.seen)) {
        (seenBy[name] = seenBy[name] || Array(turns).fill(0));
        for (let k = t - 1; k < turns; k++) seenBy[name][k]++;
      }
      let firstKey = Infinity;
      for (const [name, t] of Object.entries(r.cast)) {
        (castBy[name] = castBy[name] || Array(turns).fill(0));
        for (let k = t - 1; k < turns; k++) castBy[name][k]++;
        if (keys.has(name)) firstKey = Math.min(firstKey, t);
      }
      for (let k = firstKey - 1; k < turns; k++) if (k >= 0) keyBy[k]++;
    }
    const f = a => a.map(x => x / iters);
    return {
      avg: f(sum), ge: ge.map(f), unused: f(unused), idle: f(idle), held: f(held), inHand: f(inHand), keyBy: f(keyBy),
      castBy: Object.fromEntries(Object.entries(castBy).map(([k, v]) => [k, f(v)])),
      seenBy: Object.fromEntries(Object.entries(seenBy).map(([k, v]) => [k, f(v)])),
      board: board.map(b => Object.fromEntries(BK.map(k => [k, b[k] / iters]))),
      wide: f(wide), combo: f(combo)
    };
  }

  /**
   * 一人回し
   * entries: [{qty, card, cat}]（メインデッキ。cat は大カテゴリ）
   * opts.keys: 主力カード名の配列（なければ大カテゴリが勝ち手段・コンボ/展開のカード）
   * 戻り値: { play, draw, keyNames, autoKey, hasDisrupt, enablers, ... }
   *   play/draw.avg[t-1]      = tターン目に出せるマナの平均
   *   play/draw.ge[t-1][k]    = tターン目に k マナ以上出せる確率
   *   play/draw.castBy[name]  = tターン目までにそのカードを唱えられた確率
   *   play/draw.seenBy[name]  = tターン目までにそのカードを手札に持っていた確率
   *   play/draw.keyBy         = tターン目までに主力のどれかを唱えられた確率
   *   play/draw.idle          = 何も唱えられず、妨害も構えられなかった確率
   *   play/draw.unused        = 使い残したマナの平均（妨害を構えたターンは0）
   *   play/draw.held          = 妨害を構えられた確率
   *   play/draw.inHand        = ターン終了時に妨害を手札に持っていた確率
   */
  function simulate(entries, opts = {}) {
    const turns = opts.turns || 6, iters = opts.iters || 2000;
    const keyNames = (opts.keys || []).slice();
    const autoKey = false;
    const deck = prepare(entries, keyNames);
    deck.combos = opts.combos || []; // [{ name, pieces: [[カード名…], …] }]
    if (deck.cards.length < 8 || !deck.lands.length) return null;
    const seed = hashStr(entries.filter(e => e.card).map(e => e.qty + e.card.name).sort().join('|') + '#' + keyNames.join('|'));
    const play = run(deck, true, turns, iters, seed, keyNames);
    const draw = run(deck, false, turns, iters, seed + 1, keyNames);
    const tron = deck.tronTypes.length >= 2;
    const accel = deck.lands.some(l => l.p.base >= 2 || l.p.tron || l.p.count || (l.p.cond && l.p.cond.amt >= 2));
    const hasDisrupt = deck.cards.some(c => c.disrupt);
    // サーチ・ライブラリー操作・マナ加速のカードを1種類ずつ抜いたとき、4ターン目までに主力を唱えられる率がどう変わるか
    const T = Math.min(4, turns);
    const enablerNames = keyNames.length && opts.enablers === true
      ? [...new Set(deck.cards.filter(c => !c.land && !c.key && (c.search || c.dig || c.rock)).map(c => c.name))].slice(0, 5) : [];
    const enablers = enablerNames.map(name => {
      const blank = { name: '-', land: false, p: null, search: null, dig: null, rock: null, cost: GENERIC(0), cmc: 0, disrupt: false, key: false };
      const d2 = Object.assign({}, deck, { cards: deck.cards.map(c => c.name === name ? blank : c) });
      const r = run(d2, true, turns, Math.round(iters * 0.3), seed + 7, keyNames);
      const qty = deck.cards.filter(c => c.name === name).length;
      return { name, qty, without: r.keyBy[T - 1] };
    });
    const keyCmc = Object.fromEntries(keyNames.map(n => { const c = deck.cards.find(x => x.name === n); return [n, c ? c.cmc : 0]; }));
    return { turns, iters, play, draw, tron, accel, hasDisrupt, keyNames, keyCmc, autoKey, keyTurn: T, enablers };
  }

  const api = { simulate, landProfile, searchSpec, digSpec, rockSpec, costOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ManaSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
