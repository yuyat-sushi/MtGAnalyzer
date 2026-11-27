/*
 * マナシミュレーション
 * デッキをシャッフルして1ターンずつ動かし、ターンごとに出せるマナを調べる。
 * - 土地のマナ量はテキストから読み取る（2マナ土地、Tron、神座、Cabal Coffers、条件付きのマナ）
 * - タップ状態で出る土地、バウンスランド、フェッチランド
 * - 土地サーチ（手札へ／戦場へ）、ライブラリー操作（占術・キャントリップ・上から探す）
 * - 運命を貪るもの（Devourer of Destiny）などの初手公開
 * マリガンはせず、最初の7枚をキープする前提。
 */
(function (global) {
  'use strict';

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
    p.bounce = /return a land you control to its owner's hand/i.test(text);
    const sp = searchSpec(card);
    if (sp && sp.dest === 'battlefield') p.fetch = sp;
    return p;
  }

  const hasType = (bf, type) => bf.some(l => l.p.every || l.p.typeStr.includes(type));
  // 戦場の土地のうち、このターン使えるものから出せるマナの合計
  function manaOf(bf, rng, ratio) {
    let total = 0;
    for (const l of bf) {
      if (l.sick) continue;
      total += landMana(l.p, bf, rng, ratio);
    }
    return total;
  }
  function landMana(p, bf, rng, ratio) {
    let m = p.base;
    if (p.tron && p.tron.needs.every(n => hasType(bf, n))) m = Math.max(m, p.tron.amt);
    if (p.count) {
      const n = bf.filter(l => l.p.every || l.p.typeStr.includes(p.count.type)).length;
      m = Math.max(m, n - p.count.cost);
    }
    if (p.cond && rng && rng() < (ratio(p.cond.kw) || 0)) m = Math.max(m, p.cond.amt);
    return m;
  }
  function entersTapped(p, bf) {
    if (p.tapped === 'yes') return true;
    if (p.tapped === 'no') return false;
    if (p.tapped.fewer != null) return bf.length > p.tapped.fewer;
    if (p.tapped.more != null) return bf.length < p.tapped.more;
    if (p.tapped.types) return !p.tapped.types.some(t => hasType(bf, t));
    return false;
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
  function prepare(entries) {
    const cards = [];
    for (const e of entries) {
      const c = e.card;
      if (!c) continue;
      const land = isLandCard(c);
      const info = {
        name: c.name, card: c, land,
        p: land ? landProfile(c) : null,
        search: land ? null : searchSpec(c),
        dig: land ? null : digSpec(c),
        creature: /\bCreature\b/.test(frontType(c)),
        cost: c.cmc || 0
      };
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
  function tronOwnType(p) {
    const m = p.typeStr.match(/—\s*(.+)$/);
    return m ? m[1].trim() : null;
  }

  // ---------- 1ゲーム ----------
  function playGame(deck, onPlay, turns, rng) {
    const lib = shuffle(deck.cards.slice(), rng);
    const hand = lib.splice(0, 7);
    const bf = []; // {p, sick(このターンは使えない)}
    const perms = []; // 起動型のサーチを持つパーマネント（Expedition Map など）
    const res = [];
    const tron = deck.tronTypes;

    let floated = 0; // バウンスランドで戻す前に出したマナ
    const landsInHand = () => hand.filter(c => c.land).length;
    const missingTron = () => tron.filter(t => !bf.some(l => l.p.every || l.p.typeStr.includes(t)) && !hand.some(c => c.land && (c.p.every || c.p.typeStr.includes(t))));
    const value = c => {
      if (c.land) {
        if (tron.length && missingTron().some(t => c.p.every || c.p.typeStr.includes(t))) return 3;
        const n = landsInHand();
        return n === 0 ? 2 : n === 1 ? 1 : 0.4;
      }
      if (c.search) return landsInHand() === 0 || (tron.length && missingTron().length) ? 1.2 : 0.6;
      return landsInHand() === 0 ? 0.3 : 0.5;
    };
    // 上から n 枚を見て、欲しいものだけ上に残す（残りは下へ）
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
        v += manaOf(test, null, deck.ratio) + manaOf(test.map(l => ({ p: l.p })), null, deck.ratio);
        if (v > bv) { bv = v; best = i; }
      });
      return best;
    };
    const takeFromLib = i => { const c = lib.splice(i, 1)[0]; shuffle(lib, rng); return c; };

    // 土地を戦場に出す（フェッチ・バウンスもここで処理）
    const putLand = (c, forceTapped) => {
      const tapped = forceTapped || entersTapped(c.p, bf);
      if (c.p.fetch) {
        const i = pickTarget(c.p.fetch, 'battlefield');
        if (i >= 0) { const t = takeFromLib(i); bf.push({ p: t.p, sick: c.p.fetch.tapped || entersTapped(t.p, bf) || tapped, card: t }); return; }
      }
      const slot = { p: c.p, sick: tapped, card: c };
      bf.push(slot);
      if (c.p.bounce) {
        // 一番マナの少ない土地（なければ自分）を手札に戻す
        let ri = -1, rv = Infinity;
        bf.forEach((l, i) => {
          if (l === slot || l.p.bounce) return;
          const v = landMana(l.p, bf, null, deck.ratio) + (tron.length && tron.some(t => l.p.typeStr.includes(t)) ? 5 : 0);
          if (v < rv) { rv = v; ri = i; }
        });
        const back = ri >= 0 ? bf.splice(ri, 1)[0] : bf.splice(bf.indexOf(slot), 1)[0];
        if (!back.sick && back !== slot) floated += landMana(back.p, bf.concat([back]), null, deck.ratio); // 戻す前にマナを出しておく
        hand.push(back.card || { name: back.p.name, land: true, p: back.p });
      }
    };
    // 戦場にまだないTronパーツ（手札の土地を置く判断用）
    const missingOnBf = () => tron.filter(t => !bf.some(l => l.p.every || l.p.typeStr.includes(t)));
    // 置く土地の点数 = このターンのマナ（重み w）＋ 次のターンのマナ
    const scoreLand = (c, t) => {
      const tapped = entersTapped(c.p, bf);
      const test = bf.concat([{ p: c.p, sick: tapped }]);
      if (c.p.fetch) {
        const i = pickTarget(c.p.fetch, 'battlefield');
        if (i < 0) return -1;
        const tg = lib[i];
        test[test.length - 1] = { p: tg.p, sick: c.p.fetch.tapped || entersTapped(tg.p, bf) };
      }
      // 1ターン目に使う1マナの呪文がなければ、タップインを先に置いてよい
      const w = t === 1 && !hand.some(x => !x.land && (x.search || x.dig) && x.cost <= 1) ? 0 : 1;
      let now = manaOf(test, null, deck.ratio), next = manaOf(test.map(l => ({ p: l.p })), null, deck.ratio);
      if (c.p.bounce) {
        // 戻す土地は先にマナを出しておけるので、このターンのマナは減らない。戻した土地は後で置き直せる
        now = manaOf(bf, null, deck.ratio);
        if (!bf.length) return -1;
        next -= Math.min(...bf.map(l => landMana(l.p, bf, null, deck.ratio)));
        next += 1;
      }
      const miss = missingOnBf();
      const tronBonus = miss.length && miss.some(x => c.p.every || c.p.typeStr.includes(x)) ? 0.5 : 0;
      return now * w + next + tronBonus + (tapped || c.p.bounce ? 0.01 : 0);
    };
    const playLand = t => {
      const ls = hand.filter(c => c.land);
      if (!ls.length) return false;
      let best = ls[0], bs = -Infinity;
      ls.forEach(c => { const s = scoreLand(c, t); if (s > bs) { bs = s; best = c; } });
      hand.splice(hand.indexOf(best), 1);
      putLand(best);
      return true;
    };

    // マナを使う行動。優先順位: サーチの起動 → サーチ呪文 → 占術・キャントリップ
    let spent = 0, landDrop = true;
    const avail = () => manaOf(bf, rng, deck.ratio) + floated - spent;
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
          // 足りないTronパーツ以外で一番マナの少ない土地を生け贄に
          let si = -1, sv = Infinity;
          bf.forEach((l, k) => { const v = landMana(l.p, bf, null, deck.ratio) + (tron.some(t => l.p.typeStr.includes(t)) ? 5 : 0); if (v < sv) { sv = v; si = k; } });
          if (si >= 0) bf.splice(si, 1);
        }
        bf.push({ p: c.p, sick: spec.tapped || entersTapped(c.p, bf), card: c });
        if (spec.alsoHand) { const j = pickTarget(spec, 'hand'); if (j >= 0) hand.push(takeFromLib(j)); }
      } else hand.push(c);
    };
    const act = () => {
      for (let guard = 0; guard < 12; guard++) {
        const m = avail();
        // 1. 戦場にあるサーチの起動（Expedition Map など）
        const pi = perms.findIndex(x => x.ready && x.spec.ability.cost <= m && useful(x.spec));
        if (pi >= 0) { const x = perms.splice(pi, 1)[0]; spent += x.spec.ability.cost; doSearch(x.spec); continue; }
        // 2. 手札のサーチ
        const si = hand.findIndex(c => c.search && c.cost <= m && useful(c.search));
        if (si >= 0) {
          const c = hand.splice(si, 1)[0];
          spent += c.cost;
          if (c.search.ability) {
            const x = { spec: c.search, ready: !(c.search.ability.tap && c.creature) };
            if (x.ready && avail() >= c.search.ability.cost) { spent += c.search.ability.cost; doSearch(c.search); }
            else perms.push(x);
          } else doSearch(c.search);
          continue;
        }
        // 3. 占術・キャントリップ（土地を置いた後は、手札に土地がないときだけ急いで使う必要はないが、余ったマナで使う）
        const di = hand.findIndex(c => c.dig && !c.search && (c.dig.draw || c.dig.scry || c.dig.dig) && c.dig.cost <= m);
        if (di >= 0) {
          const c = hand.splice(di, 1)[0];
          spent += c.dig.cost;
          const d = c.dig;
          if (d.scryFirst) { scry(d.scry); draw(d.draw); } else { draw(d.draw); if (d.scry) scry(d.scry); }
          if (d.dig) dig(d.dig, d.digLand);
          continue;
        }
        break;
      }
    };

    // 初手公開（Devourer of Destiny）: 最初のアップキープに上 n 枚から1枚だけ上に残す
    hand.filter(c => c.dig && c.dig.reveal).forEach(c => {
      const top = lib.splice(0, Math.min(c.dig.reveal, lib.length));
      if (!top.length) return;
      top.sort((a, b) => value(b) - value(a));
      lib.unshift(top[0]); // 残りは追放
    });

    for (let t = 1; t <= turns; t++) {
      bf.forEach(l => { l.sick = false; });
      perms.forEach(x => { x.ready = true; });
      spent = 0; landDrop = true; floated = 0;
      if (!(onPlay && t === 1)) draw(1);
      if (!landsInHand()) act(); // 土地がなければ先に探す
      if (playLand(t)) landDrop = false;
      act();
      if (landDrop && playLand(t)) { landDrop = false; act(); }
      res.push(manaOf(bf, rng, deck.ratio) + floated);
    }
    return res;
  }

  function run(deck, onPlay, turns, iters, seed) {
    const rng = rngFrom(seed);
    const sum = Array(turns).fill(0);
    const ge = Array.from({ length: turns }, () => Array(12).fill(0));
    for (let g = 0; g < iters; g++) {
      const r = playGame(deck, onPlay, turns, rng);
      r.forEach((m, t) => { sum[t] += m; for (let k = 0; k <= Math.min(11, m); k++) ge[t][k]++; });
    }
    return { avg: sum.map(s => s / iters), ge: ge.map(row => row.map(x => x / iters)) };
  }

  /**
   * entries: [{qty, card}]（メインデッキ）
   * 戻り値: { play, draw, tron, accel, headline, enablers }
   *   play/draw.avg[t-1] = tターン目に出せるマナの平均
   *   play/draw.ge[t-1][k] = tターン目に k マナ以上出せる確率
   */
  function simulate(entries, opts = {}) {
    const turns = opts.turns || 6, iters = opts.iters || 2000;
    const deck = prepare(entries);
    if (deck.cards.length < 8 || !deck.lands.length) return null;
    const seed = hashStr(entries.filter(e => e.card).map(e => e.qty + e.card.name).sort().join('|'));
    const play = run(deck, true, turns, iters, seed);
    const draw = run(deck, false, turns, iters, seed + 1);
    const tron = deck.tronTypes.length >= 2;
    const accel = deck.lands.some(l => l.p.base >= 2 || l.p.tron || l.p.count || (l.p.cond && l.p.cond.amt >= 2));
    // 見出しの数字: Tron は 3・4ターン目に7マナ、それ以外は4ターン目に4マナ
    const headline = tron
      ? { label: 'Tron（7マナ）', turn: 4, k: 7, extra: { turn: 3, k: 7 } }
      : accel ? { label: '3ターン目に4マナ以上', turn: 3, k: 4 } : { label: '4ターン目に4マナ以上', turn: 4, k: 4 };
    // サーチ・ライブラリー操作のカードを1種類ずつ抜いたときの差
    const enablerNames = [...new Set(deck.cards.filter(c => !c.land && (c.search || c.dig)).map(c => c.name))].slice(0, 8);
    const enablers = (opts.enablers === false ? [] : enablerNames).map(name => {
      const blank = { name: '-', land: false, p: null, search: null, dig: null, cost: 0 };
      const d2 = Object.assign({}, deck, { cards: deck.cards.map(c => c.name === name ? blank : c) });
      const r = run(d2, true, turns, Math.round(iters / 2), seed + 7);
      const qty = deck.cards.filter(c => c.name === name).length;
      return { name, qty, without: r.ge[headline.turn - 1][headline.k] };
    });
    return { turns, iters, play, draw, tron, accel, headline, enablers };
  }

  const api = { simulate, landProfile, searchSpec, digSpec };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ManaSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
