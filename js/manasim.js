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
      // 信心の数だけマナを出す（Nykthos, Shrine to Nyx の「{2}, {T}: Choose a color. Add …」）。一番信心の多い色を選ぶ。起動コストは差し引く
      if (/equal to your devotion to that color/i.test(line) && line.indexOf(':') > 0) { p.devotion = { cost: genericCost(line.slice(0, line.indexOf(':'))) }; continue; }
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
    // 信心の能力の色（好きな色）は、信心があるときだけ出る。ふだんの色は、ほかのマナ能力に書かれている色だけ
    if (p.devotion) p.colors = [...new Set((text.match(/\{T\}: Add ((?:\{[WUBRGC]\})+)/g) || []).flatMap(x => x.match(/[WUBRGC](?=\})/g)))];
    if (!p.colors.length) p.colors = ['C'];
    p.bounce = /return a land you control to its owner's hand/i.test(text);
    const sp = searchSpec(card);
    if (sp && sp.dest === 'battlefield') p.fetch = sp;
    return p;
  }

  // 一番信心の多い色 { c, n }
  const devBest = dev => { let c = null, n = 0; for (const k of 'WUBRG') if (dev[k] > n) { n = dev[k]; c = k; } return { c, n }; };
  // マナ・コストの色マナ・シンボルの数（混成は両方の色に1つずつ、ファイレクシア・マナも数える）
  const pipsOf = card => {
    const out = {};
    (String(card.manaCost || '').split('//')[0].match(/\{[^}]+\}/g) || []).forEach(sym => {
      new Set(sym.match(/[WUBRG]/g) || []).forEach(c => { out[c] = (out[c] || 0) + 1; });
    });
    return out;
  };
  // 土地が出せる色（信心の能力を使うと、その色のマナだけになる）
  function landColors(l, bf) {
    const p = l.p;
    if (p.devotion && l.dev) {
      const b = devBest(l.dev);
      if (b.c && b.n - p.devotion.cost > landMana(Object.assign({}, p, { devotion: null }), bf, l)) return [b.c];
    }
    return p.colors;
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
    if (p.devotion && slot && slot.dev) m = Math.max(m, devBest(slot.dev).n - p.devotion.cost);
    if (p.cap1 && m >= 2) m = 1; // Damping Sphere: 2マナ以上出る土地は{C}1つ
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

  // ---------- 即席マナ（1回きりのマナ） ----------
  // hand: 手札から使えるマナ（エルフの指導霊・Lotus Petal・儀式の差し引き）、
  // treasure: 唱えたとき・出たときに出る宝物・落とし子の数、combat: 攻撃・戦闘ダメージで毎ターン出る宝物の数
  function fastSpec(c) {
    if (!Tags || isLandCard(c)) return null;
    const name = String(c.name || '').split(' // ')[0].toLowerCase();
    const isSpell = /\b(Instant|Sorcery)\b/.test(frontType(c));
    const out = { hand: null, treasure: 0, combat: 0 };
    for (const ab of Tags.analyze(c).abilities) {
      if (!ab.effects.includes('mana')) continue;
      const txt = ab.text;
      const cost = txt.split(':')[0];
      const anyColor = /any color|any combination|treasure|one mana of any/.test(txt);
      const col = anyColor ? ['W', 'U', 'B', 'R', 'G'] : [((txt.match(/add \{([wubrg])\}/) || [])[1] || 'c').toUpperCase()];
      const tok = txt.match(/create (a|an|one|two|three|four|x|\d+) [a-z0-9/ ]*?\b(treasure|eldrazi spawn|eldrazi scion)/);
      if (tok) {
        const n = NUM[tok[1]] || parseInt(tok[1], 10) || 1;
        if (/\b(deals combat damage|attacks)\b/.test(txt.split('create')[0])) out.combat += n;
        else if (ab.triggers.some(t => t === 'etb' || t === 'spell')) out.treasure += n;
        continue;
      }
      if (txt.includes(':') && new RegExp(`exile ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} from your hand`).test(cost)) { out.hand = { amt: 1, colors: col, kind: 'exile' }; continue; }
      if (txt.includes(':') && (cost.includes(`sacrifice ${name}`) || cost.includes('sacrifice this')) && (c.cmc || 0) === 0) { out.hand = { amt: 1, colors: col, kind: 'petal' }; continue; }
      if (isSpell && ab.triggers.includes('spell')) {
        const syms = ((txt.match(/add ((?:\{[^}]+\})+)/) || [])[1] || '').split('}').length - 1;
        const w = txt.match(/add (one|two|three) mana/);
        const net = (syms || (w ? NUM[w[1]] : 0)) - (c.cmc || 0);
        if (net > 0) out.hand = { amt: net, colors: col, kind: 'ritual' };
      }
    }
    return out.hand || out.treasure || out.combat ? out : null;
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

  // ---------- 唱えたときの行動（相手の行動干渉が効くもの） ----------
  // search: 土地以外を探す（土地サーチは doSearch で数える）、draw: 引く枚数、life: ライフを得る、extra: 追加ターン
  // 「Whenever」「At the beginning」の誘発と、起動型能力（コロンの前にコスト・忠誠度能力）は唱えたときの行動ではないので数えない
  // 「if {R}{R} was spent」のような、唱えるのに支払った色マナで効果が変わる文。1行を文に分けて、文ごとの条件の色を返す
  // 条件の文の後ろの文は、次の「If」が来るまで同じ条件とみなす（Vibrance などの想起エレメンタル）
  const SPENT_RE = /\bif \{([WUBRG])\}\{\1\} was spent/i;
  function sentencesOf(line) {
    const out = [];
    let cond = null;
    for (const sen of line.split(/(?<=\.)\s+(?=[A-Z])/)) {
      const m = sen.match(SPENT_RE);
      if (m) cond = m[1].toUpperCase(); else if (/^\s*if\b/i.test(sen)) cond = null;
      out.push({ text: sen, cond });
    }
    return out;
  }
  function actsOf(card, landSearch) {
    const out = { search: 0, draw: 0, life: 0, extra: 0, cond: [] };
    if (isLandCard(card)) return out;
    for (const line0 of frontOracle(card).split('\n')) for (const { text: line, cond } of (SPENT_RE.test(line0) ? sentencesOf(line0) : [{ text: line0, cond: null }])) {
      if (/^\s*(whenever|at the beginning)/i.test(line)) continue;
      const colon = line.indexOf(':');
      if (colon > 0 && /\{/.test(line.slice(0, colon))) continue;
      if (/^\s*\[?[+−-]?(\d+|X)\]?:/.test(line)) continue; // 忠誠度能力（起動型能力。奥義も含む）
      if (/(target|each) (player|opponent)s? (may )?(searches|draws)|opponent (searches|draws)/i.test(line)) continue;
      // 支払った色の条件がある文は、条件ごとに分けて数える（一人回しで、唱えた時点でその色を2つ出せるときだけ起きる）
      const o = cond ? { color: cond, search: 0, draw: 0, life: 0, extra: 0 } : out;
      if (!landSearch && /search your library/i.test(line)) o.search++;
      const dm = line.match(/\bdraws? (a|one|two|three|four|five|x) cards?/i);
      if (dm && !/each player/i.test(line)) o.draw += Math.max(1, num(dm[1].toLowerCase()));
      if (/\byou gain (\d+|x|that much) life|gain life equal/i.test(line)) o.life++;
      if (/take an extra turn/i.test(line)) o.extra++;
      if (cond && o.search + o.draw + o.life + o.extra) out.cond.push(o);
    }
    return out;
  }

  // プラスの忠誠度能力のうち、行動（サーチ・ドロー・ライフ回復・追加ターン）をするもの。メリットがあるので毎ターン使う
  // 複数あるときは行動の多いものを使う（トークンを出すなど、行動以外の能力を選ぶ場面は考えない）
  function plusActsOf(card) {
    if (!/\bPlaneswalker\b/.test(frontType(card))) return null;
    let best = null, bv = 0;
    for (const line of frontOracle(card).split('\n')) {
      const m = line.match(/^\s*\[?\+(\d+|X)\]?:\s*(.*)$/);
      if (!m) continue;
      const a = actsOf({ typeLine: 'Sorcery', oracle: m[2], name: card.name }, false);
      const v = a.search + a.draw + a.life + a.extra;
      if (v > bv) { bv = v; best = a; }
    }
    return best;
  }

  // 唱えたとき・戦場に出たとき（・呪文を唱えるたび）に相手のパーマネントを除去する効果。行動干渉を先に置いても、
  // このカード自身の効果で除去されるなら、このカードの行動は止められない（嵐の目、ウギン など）
  // 戻り値: { any, colored, nonland, types: [...], mvMax, dmg } または null
  function selfRemovalOf(card) {
    const TY = ['creature', 'artifact', 'enchantment', 'planeswalker', 'battle'];
    for (const raw0 of frontOracle(card).split('\n')) {
      if (!/^\s*(when you cast this spell|whenever you cast|when [^,]*? enters|when [^,]*? (is turned face up|evoked))/i.test(raw0)) continue;
      // 支払った色の条件があれば文ごとに見る（「if {R}{R} was spent to cast it, ～ deals 3 damage」）
      for (const { text: raw, cond } of (SPENT_RE.test(raw0) ? sentencesOf(raw0) : [{ text: raw0, cond: null }])) {
      const line = raw.toLowerCase();
      const out = { any: false, colored: false, nonland: false, types: [], mvMax: null, dmg: null, needColor: cond };
      const dm = line.match(/deals? (\d+) damage to (?:any target|(?:up to \w+ )?target ([a-z ,/]+?))(?:[.,]| and | an opponent| you don't)/) ||
        line.match(/deals? (\d+) damage divided [^.]*?among [^.]*?targets? ([a-z ,/]+?)[.,]/);
      const rm = line.match(/(?:exile|destroy|return)s? (?:up to )?(?:\w+ )?(?:other )?(?:target|each|all) ([a-z ,'-]+?)[.,]/);
      if (dm) { out.dmg = +dm[1]; out.types = dm[2] ? TY.filter(t => new RegExp(`\\b${t}s?\\b`).test(dm[2])) : ['creature', 'planeswalker', 'battle']; }
      else if (rm) {
        const w = rm[1].split(/ (?:an opponent|you don't|your opponents|until|with|that's|that|to its|to their)\b/)[0];
        if (/one or more colors/.test(rm[1])) out.colored = true;
        else if (/nonland/.test(w)) out.nonland = true;
        else if (/permanents?\b/.test(w)) out.any = true;
        out.types = TY.filter(t => new RegExp(`\\b${t}s?\\b`).test(w));
        const mv = line.match(/mana value (\d+) or less/);
        if (mv) out.mvMax = +mv[1];
      } else continue;
      if (/nontoken/.test(line) && !out.types.length && !out.colored) out.nonland = true;
      if (out.any || out.colored || out.nonland || out.types.length) return out;
      }
    }
    return null;
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
        fast: land ? null : fastSpec(c),
        creature: /\bCreature\b/.test(frontType(c)),
        cost: land ? GENERIC(0) : costOf(c),
        cmc: c.cmc || 0,
        cat: e.cat || null,
        key: keySet.has(c.name),
        perm: land ? null : permOf(c)
      };
      info.acts = actsOf(c, !!info.search);
      info.plusActs = land ? null : plusActsOf(c);
      // 自分で除去できて、行動もするカードだけ（行動を「止められない」扱いにするため）
      const hasAct = a => a && ((a.search + a.draw + a.life + a.extra) > 0 || (a.cond || []).length > 0);
      info.selfRm = !land && (hasAct(info.acts) || hasAct(info.plusActs) || info.search) ? selfRemovalOf(c) : null;
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
      return { types: [], etbTokens: spellTokens(c), turnTokens: [], landFx: null, reduce: [] };
    }
    const types = ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'].filter(t => new RegExp(`\\b${t}\\b`).test(front)).map(t => t.toLowerCase());
    const out = { types, power: ptOf(c.power), toughness: ptOf(c.toughness), etbTokens: [], turnTokens: [], landFx: null, reduce: [] };
    const text = frontOracle(c).toLowerCase();
    // 土地への常在効果（自分の土地にもかかる）
    if (/nonbasic lands are mountains/.test(text)) out.landFx = 'moon';
    else if (/nonbasic lands don't untap/.test(text)) out.landFx = 'b2b';
    else if (/tapped for two or more mana/.test(text)) out.landFx = 'sphere';
    // コスト軽減（「インスタントとソーサリー呪文は{1}少なくなる」など。自分自身の軽減は除く）
    for (const line of text.split('\n')) {
      const m = line.match(/^([^.]*?)spells you cast cost \{(\d)\} less to cast/);
      if (m && !/this spell/.test(m[1])) out.reduce.push({ n: +m[2], kw: m[1].replace(/\b(and|or|a|an|the)\b/g, ' ').split(/[\s,]+/).filter(Boolean) });
    }
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
    const g = { mana: [], idle: [], unused: [], held: [], inHand: [], cast: {}, seen: {}, board: [], combo: [], names: [], lands: [], groups: [], acts: [], colorMana: [], curve: {} };
    const dev = { W: 0, U: 0, B: 0, R: 0, G: 0 }; // 信心（戦場のパーマネントの色マナ・シンボルの数）
    // そのターンの行動の回数（相手の行動干渉が効くもの）。fetch はフェッチランドの生け贄起動、search は呪文・能力でのサーチ
    let ev = { fetch: 0, search: 0, draw: 0, life: 0, extra: 0 };
    const plusUsers = []; // 戦場にいて、毎ターンプラスの忠誠度能力で行動するPW
    // rm: 自分で除去できるカード → { r: 唱えたターン, by: ターン → その札がした行動 }
    const rm = {};
    // 唱えた時点で、その色のマナを2つ出せたか（戦場の土地とマナを出すパーマネントで数える。支払ったかどうかの近似）
    const twoOf = x => bf.reduce((s, l) => s + (landColors(l, bf).includes(x) ? (l.p.devotion && l.dev && landColors(l, bf)[0] === x ? Math.max(1, landMana(l.p, bf, l)) : 1) : 0), 0) +
      rocks.filter(r => (r.colors || []).includes(x)).length >= 2;
    const rmOn = new Set(); // このゲームで、自分の効果で実際に除去を起こしたカード
    const addActs = (a, src) => {
      ev.search += a.search; ev.draw += a.draw; ev.life += a.life; ev.extra += a.extra;
      if (src && src.selfRm && rmOn.has(src.name)) {
        const x = rm[src.name] = rm[src.name] || { r: turn, by: {} };
        const b = x.by[turn] = x.by[turn] || { fetch: 0, search: 0, draw: 0, life: 0, extra: 0 };
        b.search += a.search; b.draw += a.draw; b.life += a.life; b.extra += a.extra;
      }
    };
    // 盤面（土地以外）: クリーチャー {power, toughness}、それ以外のパーマネントの数、毎ターン出るトークン
    const board = { creatures: [], artifact: 0, enchantment: 0, planeswalker: 0, battle: 0, makers: [], names: { artifact: [], enchantment: [], planeswalker: [] } };
    const seenNames = new Set();
    // 自分の土地にかかる効果（自分の Blood Moon 系）とコスト軽減
    const fx = { moon: false, b2b: false, sphere: false };
    const reducers = [];
    const COLOR_WORD = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    const effCost = c => {
      if (!reducers.length || c.land) return c.cost;
      const front = frontType(c.card).toLowerCase();
      const mc = String(c.card.manaCost || '').split('//')[0];
      let less = 0;
      for (const r of reducers) {
        const ok = r.kw.every(w => {
          if (w === 'colorless') return !/[WUBRG]/.test(mc);
          if (COLOR_WORD[w]) return mc.includes(COLOR_WORD[w]);
          if (w === 'noncreature') return !/creature/.test(front);
          if (/^(instant|sorcery|artifact|creature|enchantment|planeswalker)$/.test(w)) return new RegExp(w).test(front) || (r.kw.length > 1 && r.kw.some(x => x !== w && new RegExp(x).test(front)));
          return true;
        });
        if (ok) less += r.n;
      }
      return less ? { generic: Math.max(0, c.cost.generic - less), pips: c.cost.pips } : c.cost;
    };
    // 土地のプロフィールを効果に合わせて変える（元のプロフィールは orig に残す）
    const MOON_P = { name: 'Mountain', typeStr: 'Land — Mountain', every: false, base: 1, tron: null, count: null, cond: null, tapped: 'no', bounce: false, fetch: null, colors: ['R'] };
    const fxProfile = p => {
      const basic = /\bBasic\b/.test(p.typeStr);
      if (fx.moon && !basic) p = Object.assign({}, MOON_P, { tapped: p.tapped });
      if (fx.sphere) p = Object.assign({}, p, { cap1: true });
      if (fx.b2b && !basic) p = Object.assign({}, p, { noUntap: true });
      return p;
    };
    const applyFx = () => bf.forEach(l => { l.p = fxProfile(l.orig || l.p); });
    const addPerm = c => {
      const pm = c.perm;
      if (!pm) return;
      // 信心: 戦場に出したパーマネントのマナ・コストの色マナ・シンボル
      if (pm.types.length) Object.entries(pipsOf(c.card)).forEach(([k, v]) => { dev[k] += v; });
      if (pm.landFx && !fx[pm.landFx]) { fx[pm.landFx] = true; applyFx(); }
      (pm.reduce || []).forEach(r => reducers.push(r));
      const front = String(c.name).split(' // ')[0];
      const tokName = t => `${t.power}/${t.toughness} トークン（${front}）`;
      pm.etbTokens.forEach(t => board.creatures.push({ ...t, name: tokName(t) }));
      if (!pm.types.length) return;
      if (pm.types.includes('creature')) board.creatures.push({ power: pm.power, toughness: pm.toughness, name: front });
      ['artifact', 'enchantment', 'planeswalker', 'battle'].forEach(t => {
        if (pm.types.includes(t) && !pm.types.includes('creature')) { board[t]++; if (board.names[t]) board.names[t].push(front); }
      });
      if (pm.turnTokens.length) board.makers.push(pm.turnTokens.map(t => ({ ...t, name: tokName(t) })));
    }; // cast/seen: 名前 → 最初に唱えた／手札にあったターン
    let floated = null; // バウンスランドで戻す前に出したマナ
    const pool = { n: 0, used: 0 };  // 貯めている宝物・落とし子
    let combatTreasure = 0;          // 攻撃・戦闘ダメージで毎ターン出る宝物（戦場にいるクリーチャーの分） {amt, colors, used}
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
      bf.forEach(l => { if (!l.sick) out.push({ ref: l, amt: landMana(l.p, bf, l) - l.used, colors: landColors(l, bf) }); });
      rocks.forEach(r => { if (!r.sick) out.push({ ref: r, amt: r.amt - r.used, colors: r.colors }); });
      if (floated) out.push({ ref: floated, amt: floated.amt - floated.used, colors: ['W', 'U', 'B', 'R', 'G'] });
      // 即席マナは最後に使う（宝物、手札のエルフの指導霊・Lotus Petal・儀式）
      if (pool.n - pool.used > 0) out.push({ ref: pool, amt: pool.n - pool.used, colors: ['W', 'U', 'B', 'R', 'G'], fast: true });
      hand.forEach(c => { if (c.fast && c.fast.hand) out.push({ ref: { handCard: c, used: 0 }, amt: c.fast.hand.amt, colors: c.fast.hand.colors, fast: true }); });
      return out.filter(s => s.amt > 0);
    };
    const avail = () => sources().reduce((s, x) => s + x.amt, 0);
    // 色の支払い方を決める（色の少ない発生源から使う）。払えなければ null
    const plan = cost => {
      const src = sources().map(s => ({ ...s })).sort((a, b) => (a.fast ? 1 : 0) - (b.fast ? 1 : 0));
      const use = new Map();
      const take = (s, n) => { s.amt -= n; use.set(s.ref, (use.get(s.ref) || 0) + n); };
      for (const [col, n] of Object.entries(cost.pips)) {
        for (let i = 0; i < n; i++) {
          const s = src.filter(x => x.amt > 0 && x.colors.includes(col)).sort((a, b) => ((a.fast ? 1 : 0) - (b.fast ? 1 : 0)) || (a.colors.length - b.colors.length))[0];
          if (!s) return null;
          take(s, 1);
        }
      }
      let rest = cost.generic;
      for (const s of src.sort((a, b) => ((a.fast ? 1 : 0) - (b.fast ? 1 : 0)) || (a.colors.length - b.colors.length))) {
        if (rest <= 0) break;
        const n = Math.min(s.amt, rest);
        if (n > 0) { take(s, n); rest -= n; }
      }
      return rest > 0 ? null : use;
    };
    const pay = cost => {
      const use = plan(cost);
      if (!use) return false;
      use.forEach((n, ref) => {
        ref.used += n;
        // 使った即席マナを消す（手札のカードは使い切り、宝物は数を減らす）
        if (ref.handCard) { const i = hand.indexOf(ref.handCard); if (i >= 0) hand.splice(i, 1); }
        if (ref === pool) { pool.n -= pool.used; pool.used = 0; }
      });
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
    const newSlot = (c, sick) => ({ p: fxProfile(c.p), orig: c.p, sick, card: c, used: 0, dev, condOn: !!(c.p.cond && rng() < deck.ratio(c.p.cond.kw)) });

    // ---- 土地 ----
    const putLand = c => {
      const tapped = entersTapped(c.p, bf);
      if (c.p.fetch) {
        const i = pickTarget(c.p.fetch, 'battlefield');
        if (i >= 0) { const t = takeFromLib(i); ev.fetch++; bf.push(newSlot(t, c.p.fetch.tapped || entersTapped(t.p, bf) || tapped)); return; }
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
      ev.search++;
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
      if (c.selfRm && (!c.selfRm.needColor || twoOf(c.selfRm.needColor))) rmOn.add(c.name);
      if (c.acts) {
        addActs(c.acts, c);
        c.acts.cond.forEach(o => { if (twoOf(o.color)) addActs(o, c); });
      }
      // 出したターンから使う。伝説のPWは同じ名前を2枚目からは数えない（レジェンド・ルール）
      if (c.plusActs && !(/\bLegendary\b/.test(frontType(c.card)) && plusUsers.some(x => x.name === c.name))) { plusUsers.push({ name: c.name, a: c.plusActs, src: c }); addActs(c.plusActs, c); }
      if (!(c.name in g.seen)) g.seen[c.name] = turn;
      if (!(c.name in g.cast)) g.cast[c.name] = turn;
    };
    const castFromHand = c => {
      if (!pay(effCost(c))) return false;
      hand.splice(hand.indexOf(c), 1);
      record(c);
      // 使い捨てのキャントリップ（Chromatic Star など）と、起動して生け贄にするサーチは盤面に残さない
      if (!(c.dig && /\bArtifact\b/.test(frontType(c.card))) && !(c.search && c.search.ability)) addPerm(c);
      if (c.fast) { pool.n += c.fast.treasure; combatTreasure += c.fast.combat; }
      return true;
    };
    const canPay = cost => !!plan(cost);
    // 1回分の行動。何かしたら true
    const step = (lateCantrips) => {
      // 1. 戦場にあるサーチの起動（Expedition Map など）
      const pi = perms.findIndex(x => x.ready && useful(x.spec) && canPay(GENERIC(x.spec.ability.cost)));
      if (pi >= 0) { const x = perms.splice(pi, 1)[0]; pay(GENERIC(x.spec.ability.cost)); castThisTurn++; doSearch(x.spec); return true; }
      // 2. 手札の土地サーチ
      const sc = hand.find(c => c.search && useful(c.search) && canPay(effCost(c)));
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
      const rc = hand.find(c => c.rock && canPay(effCost(c)));
      if (rc) { castFromHand(rc); rocks.push({ amt: rc.rock.amt, colors: rc.rock.colors, sick: rc.rock.creature, used: 0 }); return true; }
      // 4. 土地がないときの占術・キャントリップ
      const digs = hand.filter(c => c.dig && !c.search && (c.dig.draw || c.dig.scry || c.dig.dig) && canPay(effCost(c)));
      const castDig = c => {
        castFromHand(c);
        const d = c.dig;
        if (d.scryFirst) { scry(d.scry); draw(d.draw); } else { draw(d.draw); if (d.scry) scry(d.scry); }
        if (d.dig) dig(d.dig, d.digLand);
        return true;
      };
      if (!landsInHand() && landDrop && digs.length) return castDig(digs[0]);
      // 5. 主力 → それ以外（妨害は構えるので唱えない）。重いものから唱えてマナを使い切る
      const spells = hand.filter(c => !c.land && !c.disrupt && !c.rock && !c.search && !c.dig && !(c.fast && c.fast.hand) && canPay(effCost(c)));
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
      bf.forEach(l => { l.sick = !!l.p.noUntap; l.used = 0; l.condOn = !!(l.p.cond && rng() < deck.ratio(l.p.cond.kw)); });
      rocks.forEach(r => { r.sick = false; r.used = 0; });
      perms.forEach(x => { x.ready = true; });
      floated = null; landDrop = true; castThisTurn = 0; otherSpent = 0;
      ev = { fetch: 0, search: 0, draw: 0, life: 0, extra: 0 };
      plusUsers.forEach(x => addActs(x.a, x.src));
      // 毎ターン（攻撃時・終了時など）トークンを出すパーマネントは、1ターンに1回出したものとして近似
      board.makers.forEach(list => list.forEach(t => board.creatures.push({ ...t })));
      pool.n += combatTreasure; // 前のターンまでに出たクリーチャーが攻撃して宝物を出したものとする
      if (!(onPlay && turn === 1)) draw(1);
      if (!landsInHand()) act(false); // 土地がなければ先に探す
      playLand();
      act(false);
      if (playLand()) act(false);
      act(true);
      // 集計: 出せるマナ（使った分も含む）、何もできなかったか、使い残し、妨害を構えられたか
      const total = manaOf(bf) + rocks.reduce((s, r) => s + (r.sick ? 0 : r.amt), 0) + (floated ? floated.amt : 0);
      const left = sources().filter(x => !x.fast).reduce((s, x) => s + x.amt, 0);
      // 主力以外の呪文を我慢すれば構えられたか（使ったマナを好きな色で戻して判定する近似）
      if (otherSpent) floated = { amt: (floated ? floated.amt - floated.used : 0) + otherSpent, used: 0 };
      const held = hand.some(c => c.disrupt && canPay(effCost(c)));
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
      // 土地: 枚数・基本土地・名前と、土地への対策が効いたときのマナ（元のプロフィールで計算）
      const rockMana = rocks.reduce((s, r) => s + (r.sick ? 0 : r.amt), 0);
      const origBf = bf.map(l => ({ p: l.orig || l.p, sick: l.sick, condOn: l.condOn, dev: l.dev }));
      const isBasic = l => /\bBasic\b/.test(l.p.typeStr);
      const live = origBf.filter(l => !l.sick);
      const moonBf = origBf.map(l => isBasic(l) ? l : { p: MOON_P, sick: l.sick });
      const alt = {
        normal: manaOf(origBf) + rockMana,
        moon: manaOf(moonBf) + rockMana,
        sphere: live.reduce((s, l) => s + Math.min(landMana(l.p, origBf, l), 1), 0) + rockMana,
        b2b: live.filter(isBasic).reduce((s, l) => s + landMana(l.p, origBf, l), 0) + rockMana,
        ld: (origBf.length ? Math.min(...origBf.map((_, i) => manaOf(origBf.filter((__, j) => j !== i)))) : 0) + rockMana
      };
      g.lands.push({ n: bf.length, basic: origBf.filter(isBasic).length, alt });
      const landNames = new Set(bf.map(l => String((l.card && l.card.name) || l.p.name).split(' // ')[0]));
      // 対策札のグループ: そのターンに手札にあって唱えられる（またはすでに唱えた）か
      const grp = {};
      for (const [gname, list] of Object.entries(deck.groups || {})) {
        const set = new Set(list.map(nk));
        grp[gname] = hand.some(c => set.has(nk(c.name)) && canPay(effCost(c))) || Object.keys(g.cast).some(n => set.has(nk(n))) ||
          bf.some(l => l.card && set.has(nk(l.card.name)));
      }
      g.groups.push(grp);
      g.acts.push(ev);
      g.names.push({ land: landNames, creature: new Set(cr.map(x => x.name)), artifact: new Set(board.names.artifact), enchantment: new Set(board.names.enchantment), planeswalker: new Set(board.names.planeswalker) });
      g.combo.push((deck.combos || []).some(cb => cb.pieces.every(gr => gr.some(n => seenNames.has(nk(n))))));
      // カーブどおりに唱えられるか: MVと同じターンに、そのターンのマナを全部使えたとして（使った分も戻して）コストを払えるか。
      // 払えないとき、色を無視すれば払えるなら「色不足」（足りない色も記録）、それでも払えなければ「マナ不足」
      const cc = (deck.curveCards || []).filter(x => x.t === turn);
      if (cc.length) {
        const saved = bf.map(l => l.used), savedR = rocks.map(r => r.used);
        bf.forEach(l => { l.used = 0; }); rocks.forEach(r => { r.used = 0; });
        cc.forEach(({ c }) => {
          const cost = effCost(c);
          if (plan(cost)) { g.curve[c.name] = { ok: true }; return; }
          const n = cost.generic + Object.values(cost.pips).reduce((a, b) => a + b, 0);
          if (!plan({ generic: n, pips: {} })) { g.curve[c.name] = { ok: false, why: 'mana' }; return; }
          const miss = Object.keys(cost.pips).filter(col => !plan({ generic: 0, pips: { [col]: cost.pips[col] } }));
          g.curve[c.name] = { ok: false, why: 'color', miss: miss.length ? miss : Object.keys(cost.pips) };
        });
        bf.forEach((l, i) => { l.used = saved[i]; }); rocks.forEach((r, i) => { r.used = savedR[i]; });
      }
      g.mana.push(total);
      // 色ごとに出せるマナ（その色だけを出すとしたときの最大。土地とマナを出すパーマネント）
      const cm = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      bf.forEach(l => { if (l.sick) return; const a = landMana(l.p, bf, l); landColors(l, bf).forEach(k => { cm[k] += a; }); });
      rocks.forEach(r => { if (!r.sick) r.colors.forEach(k => { cm[k] += r.amt; }); });
      g.colorMana.push(cm);
      g.unused.push(held ? 0 : left);
      g.held.push(held);
      g.inHand.push(hand.some(c => c.disrupt));
      g.idle.push(castThisTurn === 0 && !held);
    }
    g.rm = rm;
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
    const NT = ['land', 'creature', 'artifact', 'enchantment', 'planeswalker'];
    const AK = ['normal', 'moon', 'sphere', 'b2b', 'ld'];
    const landsAgg = Array.from({ length: turns }, () => ({ n: 0, basic: 0, alt: Object.fromEntries(AK.map(k => [k, 0])) }));
    const groupsAgg = {};
    const EK = ['fetch', 'search', 'draw', 'life', 'extra'];
    const CK = ['W', 'U', 'B', 'R', 'G', 'C'];
    const cmAgg = Array.from({ length: turns }, () => Object.fromEntries(CK.map(k => [k, 0])));
    const actsAgg = Array.from({ length: turns }, () => Object.fromEntries(EK.map(k => [k, 0])));
    const rmAgg = {};
    const curveAgg = {}; // カード名 → { ok, mana, color, miss: {色: 回数} } // カード名 → 唱えたターン r → ターン t → 行動の合計
    const names = Object.fromEntries(NT.map(k => [k, {}])); // 種類 → カード名 → ターンごとの「戦場にある」回数
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
      r.names.forEach((nm, t) => NT.forEach(k => nm[k].forEach(n => { (names[k][n] = names[k][n] || Array(turns).fill(0))[t]++; })));
      r.lands.forEach((l, t) => { landsAgg[t].n += l.n; landsAgg[t].basic += l.basic; AK.forEach(k => { landsAgg[t].alt[k] += l.alt[k]; }); });
      r.acts.forEach((a, t) => EK.forEach(k => { actsAgg[t][k] += a[k]; }));
      r.colorMana.forEach((a, t) => CK.forEach(k => { cmAgg[t][k] += a[k]; }));
      for (const [name, x] of Object.entries(r.curve)) {
        const o = curveAgg[name] = curveAgg[name] || { ok: 0, mana: 0, color: 0, miss: {} };
        if (x.ok) o.ok++; else if (x.why === 'mana') o.mana++; else { o.color++; x.miss.forEach(col => { o.miss[col] = (o.miss[col] || 0) + 1; }); }
      }
      for (const [name, x] of Object.entries(r.rm)) for (const [t, b] of Object.entries(x.by)) {
        const key = `${x.r}-${t}`, o = ((rmAgg[name] = rmAgg[name] || {})[key] = rmAgg[name][key] || Object.fromEntries(EK.map(k => [k, 0])));
        EK.forEach(k => { o[k] += b[k]; });
      }
      r.groups.forEach((gr, t) => Object.entries(gr).forEach(([k, v]) => { (groupsAgg[k] = groupsAgg[k] || Array(turns).fill(0)); if (v) groupsAgg[k][t]++; }));
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
      wide: f(wide), combo: f(combo),
      // 種類ごとに、そのターンに戦場に1枚以上ある確率（カード名・トークンは「P/T トークン（出したカード）」）
      names: Object.fromEntries(NT.map(k => [k, Object.fromEntries(Object.entries(names[k]).map(([n, v]) => [n, f(v)]))])),
      // 土地の平均枚数・基本土地の枚数と、Blood Moon／Damping Sphere／Back to Basics／土地1枚破壊のときの出せるマナ
      lands: landsAgg.map(l => ({ n: l.n / iters, basic: l.basic / iters, alt: Object.fromEntries(AK.map(k => [k, l.alt[k] / iters])) })),
      // 対策札のグループを、そのターンまでに手札に持って唱えられる率
      groups: Object.fromEntries(Object.entries(groupsAgg).map(([k, v]) => [k, f(v)])),
      // そのターンに行った行動の平均回数（フェッチ・呪文や能力でのサーチ・ドロー枚数・ライフ回復・追加ターン）
      acts: actsAgg.map(a => Object.fromEntries(EK.map(k => [k, a[k] / iters]))),
      // 色ごとに出せるマナの平均（その色だけを出すとしたとき）
      colorMana: cmAgg.map(a => Object.fromEntries(CK.map(k => [k, a[k] / iters]))),
      // カーブどおり（MVと同じターン）にコストを払えた率と、払えなかった理由（マナ不足・色不足と足りない色）
      curve: (deck.curveCards || []).map(({ c, t, qty }) => {
        const o = curveAgg[c.name] || { ok: 0, mana: 0, color: 0, miss: {} };
        return { name: c.name, mv: Math.round(c.cmc), t, qty, ok: o.ok / iters, mana: o.mana / iters, color: o.color / iters,
          miss: Object.fromEntries(Object.entries(o.miss).map(([k, v]) => [k, v / iters])) };
      }),
      // 自分で除去できるカードの行動: カード名 → [{ r: 唱えたターン, t: 行動したターン, 行動の平均回数 }]
      rmActs: Object.fromEntries(Object.entries(rmAgg).map(([n, m]) => [n, Object.entries(m).map(([key, o]) => {
        const [r, t] = key.split('-').map(Number);
        return Object.assign({ r, t }, Object.fromEntries(EK.map(k => [k, o[k] / iters])));
      })]))
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
    deck.groups = opts.groups || {};  // { グループ名: [カード名…] }（対策札をそのターンに唱えられる率を見る）
    if (deck.cards.length < 8 || !deck.lands.length) return null;
    // カーブどおりに唱えられるかを見るカード（土地以外・MV1以上。名前ごとに1枚。MV7以上は最後のターンで見る）
    const seenCurve = new Set();
    deck.curveCards = deck.cards.filter(c => !c.land && Math.round(c.cmc) >= 1 && !seenCurve.has(c.name) && seenCurve.add(c.name))
      .map(c => ({ c, t: Math.min(turns, Math.round(c.cmc)), qty: deck.cards.filter(x => x.name === c.name).length }));
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

  // カードが行う行動（行動干渉が効くもの）: fetch / search / draw / life / extra の配列
  function actionKinds(card) {
    if (isLandCard(card)) return landProfile(card).fetch ? ['fetch'] : [];
    const sp = searchSpec(card), a = actsOf(card, !!sp), pa = plusActsOf(card);
    [pa, ...a.cond].forEach(x => { if (x) ['search', 'draw', 'life', 'extra'].forEach(k => { a[k] += x[k]; }); });
    return [...(sp || a.search ? ['search'] : []), ...['draw', 'life', 'extra'].filter(k => a[k])];
  }
  const api = { simulate, landProfile, searchSpec, digSpec, rockSpec, costOf, actionKinds, selfRemovalOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ManaSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
