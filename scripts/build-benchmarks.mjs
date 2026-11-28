#!/usr/bin/env node
/*
 * 上位デッキの「役割の枚数」ベンチマークを作る集計スクリプト（GitHub Actions から週1回実行）
 *
 * 入力
 *   --decks       fbettega/MTG_decklistcache の Tournaments/MTGO フォルダ
 *   --formatdata  Badaro/MTGOFormatData の Formats フォルダ
 *   --out         出力先（既定: benchmarks）
 *   --days        集計期間（日数。既定: 60）
 *   --cards       Scryfall の oracle-cards バルクJSON（省略時はダウンロード）
 *
 * 出力
 *   benchmarks/index.json               集計の概要・出典
 *   benchmarks/<format>.json            フォーマット全体とアーキタイプ別の役割枚数（中央値・四分位）
 *   benchmarks/archetypes/<format>.json アプリ側でアーキタイプ判定に使う定義（MTGOFormatData由来）
 *   benchmarks/diagnostics/<format>.json 役割判定の見直し用（「その他」判定が多いカードなど）
 *
 * 生のデッキリストは再配布せず、集計値だけを出力する。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const Roles = require(path.join(ROOT, 'js/roles.js'));
const Tags = require(path.join(ROOT, 'js/tags.js'));
const CardModel = require(path.join(ROOT, 'js/cardmodel.js'));
const Archetype = require(path.join(ROOT, 'js/archetype.js'));
const Combos = require(path.join(ROOT, 'js/combos.js'));
const ManaSim = require(path.join(ROOT, 'js/manasim.js'));
const COMBOS = path.join(ROOT, 'data/combos.json');
if (fs.existsSync(COMBOS)) Combos.setCombos(JSON.parse(fs.readFileSync(COMBOS, 'utf8')));

const FORMATS = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern',
  legacy: 'Legacy', vintage: 'Vintage', pauper: 'Pauper'
};
const ROLE_IDS = Roles.ROLES.map(r => r.id);
const CAT_IDS = Roles.CATEGORIES.map(c => c.id);
// 例外リスト（カード名で採用理由を指定）。アプリと同じファイルを使う
const OVERRIDES = path.join(ROOT, 'data/overrides.json');
if (fs.existsSync(OVERRIDES)) Roles.setOverrides(JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')));
const MAX_PER_EVENT_ARCHETYPE = 3;   // 1つの大会の同一アーキタイプは最大3デッキまで数える
const REFERENCE_THRESHOLD = 10;      // これ未満のサンプル数は「参考値」
const USER_AGENT = 'MtGAnalyzer/1.0 (+https://github.com/yuyat-sushi/MtGAnalyzer)';

// ---------- 引数 ----------
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
if (!args.decks || !args.formatdata) {
  console.error('usage: build-benchmarks.mjs --decks <Tournaments/MTGO> --formatdata <Formats> [--out benchmarks] [--days 60] [--cards oracle-cards.json]');
  process.exit(1);
}
const OUT = path.resolve(args.out || path.join(ROOT, 'benchmarks'));
const DAYS = Number(args.days || 60);
const today = args.today ? new Date(args.today) : new Date();
const cutoff = new Date(today.getTime() - DAYS * 86400000);
const iso = d => d.toISOString().slice(0, 10);

// ---------- カードデータ ----------
async function loadOracle() {
  if (args.cards) return JSON.parse(fs.readFileSync(args.cards, 'utf8'));
  const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
  // 一覧から oracle_cards を探す（ダウンロードURLは毎日変わる）
  const listRes = await fetch('https://api.scryfall.com/bulk-data', { headers });
  const list = await listRes.json().catch(() => null);
  const items = (list && list.data) || [];
  const item = items.find(x => x.type === 'oracle_cards');
  if (!item) {
    throw new Error(`oracle_cards が見つかりません (HTTP ${listRes.status}): ${JSON.stringify(list).slice(0, 500)}`);
  }
  console.log(`Scryfall bulk item keys: ${Object.keys(item).join(', ')}`);
  // 2026年時点の形式は gzip 圧縮の JSON Lines（jsonl_download_uri）。旧形式の download_uri（JSON配列）にも対応
  const url = item.jsonl_download_uri || item.download_uri;
  if (!url) throw new Error('ダウンロードURLが見つかりません: ' + JSON.stringify(item).slice(0, 800));
  const size = item.compressed_size || item.size;
  console.log(`Scryfall bulk: ${url} (${size ? (size / 1e6).toFixed(0) + 'MB' : 'size unknown'}, updated ${item.updated_at})`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`bulk download failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // fetch が自動で展開している場合もあるので、gzip のマジックバイトで判定する
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
  let data;
  if (text.trimStart().startsWith('[')) data = JSON.parse(text);
  else data = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  console.log(`Scryfall cards: ${data.length}`);
  return data;
}

const NON_GAME = new Set(['token', 'double_faced_token', 'art_series', 'emblem', 'planar', 'scheme', 'vanguard']);
function buildCardIndex(oracle) {
  const idx = new Map();
  const put = (k, card, game) => {
    const prev = idx.get(k);
    if (!prev || (!prev.game && game)) idx.set(k, { card, game });
  };
  for (const raw of oracle) {
    const game = !NON_GAME.has(raw.layout);
    const card = CardModel.slim(raw);
    put(CardModel.nameKey(card.name), card, game);
    if (card.name.includes(' // ')) put(CardModel.nameKey(card.name.split(' // ')[0]), card, game);
    (card.faceNames || []).forEach(f => put(CardModel.nameKey(f), card, game));
  }
  return name => (idx.get(CardModel.nameKey(name)) || {}).card || null;
}

// ---------- アーキタイプ定義 ----------
function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '');
    try { return JSON.parse(text); } catch (e) { /* 末尾カンマなどを許容して再挑戦 */ }
    try { return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')); }
    catch (e) { console.warn('skip broken json', path.join(dir, f)); return null; }
  }).filter(Boolean);
}
const normCond = c => ({ type: c.Type, cards: c.Cards || [] });
function loadDefs(formatDir) {
  const normArch = a => ({
    name: a.Name,
    includeColor: !!a.IncludeColorInName,
    conditions: (a.Conditions || []).map(normCond),
    variants: (a.Variants || []).map(v => ({ name: v.Name, includeColor: !!v.IncludeColorInName, conditions: (v.Conditions || []).map(normCond) }))
  });
  return {
    archetypes: readJsonDir(path.join(formatDir, 'Archetypes')).map(normArch),
    fallbacks: readJsonDir(path.join(formatDir, 'Fallbacks')).map(f => ({ name: f.Name, includeColor: !!f.IncludeColorInName, commonCards: f.CommonCards || [] }))
  };
}

// ---------- デッキ ----------
function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.name.endsWith('.json')) yield p;
  }
}
// キャッシュには大文字始まり・小文字スネークの両方の表記がある
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null) return o[k]; return undefined; };
const entries = list => (list || []).map(e => ({
  name: pick(e, 'CardName', 'card_name', 'cardName', 'Name', 'name'),
  qty: Number(pick(e, 'Count', 'count', 'Quantity', 'quantity') || 0)
})).filter(e => e.name && e.qty > 0);

function formatOf(tournament, file) {
  const f = String(pick(tournament, 'Formats', 'formats', 'Format', 'format') || '').toLowerCase();
  for (const k of Object.keys(FORMATS)) if (f === k || f.startsWith(k)) return k;
  const base = path.basename(file).toLowerCase();
  for (const k of Object.keys(FORMATS)) if (base.startsWith(k + '-')) return k;
  return null;
}

// ---------- 統計 ----------
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)).toFixed(2);
}
function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { median: quantile(s, 0.5), q1: quantile(s, 0.25), q3: quantile(s, 0.75), mean: +mean.toFixed(2) };
}
function summarizeGroup(decks) {
  const out = { n: decks.length, roles: {} };
  for (const r of ROLE_IDS) out.roles[r] = summarize(decks.map(d => d.roles[r] || 0));
  out.cats = {};
  for (const c of CAT_IDS) out.cats[c] = summarize(decks.map(d => d.cats[c] || 0));
  // 効果タグ（"effect:kind"。kind = spell 呪文 / activated 起動型 / triggered 誘発型 / static 常在型）。どのデッキにもほぼ無いものは省く
  out.tags = {};
  const keys = new Set(decks.flatMap(d => Object.keys(d.tagCounts)));
  for (const k of keys) {
    const s = summarize(decks.map(d => d.tagCounts[k] || 0));
    if (s.q3 > 0 || s.mean >= 0.5) out.tags[k] = s;
  }
  out.disrupt = {};
  for (const k of new Set(decks.flatMap(d => Object.keys(d.disrupt)))) {
    const s = summarize(decks.map(d => d.disrupt[k] || 0));
    if (s.q3 > 0 || s.mean >= 0.5) out.disrupt[k] = s;
  }
  out.perm = {};
  for (const k of ['creature', 'artifact', 'enchantment', 'planeswalker']) out.perm[k] = summarize(decks.map(d => d.perm[k] || 0));
  out.avgMV = summarize(decks.map(d => d.avgMV));
  out.mainCount = summarize(decks.map(d => d.mainCount));
  return out;
}
function keyCards(decks, limit) {
  const m = new Map();
  for (const d of decks) for (const c of d.cards) {
    if (c.roles.includes('land')) continue;
    const e = m.get(c.name) || { name: c.name, decks: 0, copies: 0, roles: c.roles, cat: c.cat };
    e.decks++; e.copies += c.qty; m.set(c.name, e);
  }
  return [...m.values()].sort((a, b) => b.decks - a.decks || b.copies - a.copies).slice(0, limit)
    .map(e => ({ name: e.name, rate: +(e.decks / decks.length).toFixed(2), avg: +(e.copies / e.decks).toFixed(2), cat: e.cat, roles: e.roles }));
}

// ---------- 対策の軸用: 脅威カード・代表リスト・一人回し ----------
// 対処する価値のある脅威: そのアーキタイプの40%以上が採用していて、
//   - 主な採用理由が勝ち手段・コンボ/展開のカード（インスタント・ソーサリーはコンボ/展開のみ）
//   - または、居座って働くパーマネント（クリーチャー・プレインズウォーカー、エンジン、フィニッシャー）
// キャントリップや使い捨てのドローのような「デッキを回すためのカード」は除く
function isThreat(c) {
  if (c.roles.includes('land')) return false;
  const front = String(c.typeLine || '').split(' // ')[0];
  const spell = /\b(Instant|Sorcery)\b/.test(front);
  if (spell) return c.cat === 'combo';
  if (c.cat === 'damage' || c.cat === 'combo') return true;
  if (/\bPlaneswalker\b/.test(front)) return true;

  return c.cat === 'resource' && /\bCreature\b/.test(front);
}
function threatsOf(ds, limit = 6) {
  const m = new Map();
  for (const d of ds) for (const c of d.cards) {
    if (!isThreat(c)) continue;
    const e = m.get(c.name) || { c, decks: 0, copies: 0 };
    e.decks++; e.copies += c.qty; m.set(c.name, e);
  }
  return [...m.values()].filter(e => e.decks / ds.length >= 0.4)
    .sort((a, b) => b.decks - a.decks || b.copies - a.copies).slice(0, limit)
    .map(({ c, decks, copies }) => ({
      name: c.name.split(' // ')[0], rate: +(decks / ds.length).toFixed(2), avg: +(copies / decks).toFixed(1), cat: c.cat,
      type: String(c.typeLine || '').split(' // ')[0], mv: c.card ? c.card.cmc : null,
      power: c.card ? c.card.power : null, toughness: c.card ? c.card.toughness : null
    }));
}
// 代表リスト: ほかのデッキとの共通カード（枚数の小さいほう）の合計が一番大きいデッキ
function representative(ds) {
  const sample = ds.slice(0, 80);
  const vs = sample.map(d => new Map(d.cards.map(c => [c.name, c.qty])));
  let best = 0, bs = -1;
  vs.forEach((a, i) => {
    let s = 0;
    vs.forEach((b, j) => { if (i !== j) for (const [k, q] of a) s += Math.min(q, b.get(k) || 0); });
    if (s > bs) { bs = s; best = i; }
  });
  return sample[best];
}
const r2 = a => a.map(x => +x.toFixed(2));
const r2o = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)]));
// 代表リストを一人回しして、3・4・5ターン目の盤面・マナ・妨害・コンボを保存する（対策の傾向を決めるため）
function simOf(ds) {
  const rep = representative(ds);
  if (!rep) return null;
  const lands = rep.cards.filter(c => c.roles.includes('land')).reduce((s, c) => s + c.qty, 0);
  const combos = Combos.detect({ main: rep.cards.map(c => ({ name: c.name, qty: c.qty })) }, lands)
    .filter(x => x.complete).map(x => ({ name: x.combo.name, pieces: x.combo.pieces }));
  const r = ManaSim.simulate(rep.cards.map(c => ({ qty: c.qty, card: c.card, cat: c.cat })), { iters: 800, combos });
  if (!r) return null;
  const side = s => ({
    board: [3, 4, 5].map(t => r2o(s.board[t - 1])),
    wide: r2([3, 4, 5].map(t => s.wide[t - 1])),
    mana: r2([3, 4, 5].map(t => s.avg[t - 1])),
    held: r2([3, 4, 5].map(t => s.held[t - 1])),
    combo: r2([3, 4, 5].map(t => s.combo[t - 1])),
    // 1〜6ターン目それぞれに行った行動の平均回数（行動干渉が間に合うかを見るため、全ターン分）
    acts: s.acts.map(r2o),
    // 3・4・5ターン目に色ごとに出せるマナ（その色だけを出すとしたとき。Nykthos は信心の多い色）
    colorMana: [3, 4, 5].map(t => r2o(s.colorMana[t - 1])),
    // カーブどおりに唱えられる率（枚数で重み付け）と、払えなかった内訳
    curve: (() => {
      const W = s.curve.reduce((x, c) => x + c.qty, 0) || 1;
      const w = k => +(s.curve.reduce((x, c) => x + c.qty * c[k], 0) / W).toFixed(3);
      return { ok: w('ok'), mana: w('mana'), color: w('color') };
    })(),
    screw3: +(1 - (s.ge[2][3] || 0)).toFixed(3),
    // 自分の効果で行動干渉を除去できるカード（嵐の目、ウギン など）の行動: r = 唱えたターン、t = 行動したターン
    rmActs: Object.fromEntries(Object.entries(s.rmActs || {}).map(([n, list]) => [n,
      list.map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'r' || k === 't' ? v : +v.toFixed(3)])))
        .filter(o => ['fetch', 'search', 'draw', 'life', 'extra'].some(k => o[k] >= 0.001))])),
    // 土地の平均枚数・基本土地と、土地への対策（Blood Moon／Damping Sphere／Back to Basics／土地1枚破壊）が効いたときのマナ
    lands: [3, 4, 5].map(t => ({ n: +s.lands[t - 1].n.toFixed(2), basic: +s.lands[t - 1].basic.toFixed(2), alt: r2o(s.lands[t - 1].alt) })),
    // 3・4・5ターン目に戦場にある確率が高いカード（種類ごとに、4ターン目に5%以上のものを上位8枚）
    cards: Object.fromEntries(Object.entries(s.names).map(([k, m]) => [k,
      Object.entries(m).map(([name, v]) => ({ name, r: r2([3, 4, 5].map(t => v[t - 1])) }))
        .filter(x => Math.max(...x.r) >= 0.05).sort((a, b) => b.r[1] - a.r[1]).slice(0, 8)]))
  });
  // 行動（フェッチ・サーチ・ドロー・ライフ回復・追加ターン）をするカードと、先手で3・4・5ターン目までに唱えた率（土地は手札に来た率）
  const actCards = rep.cards.map(c => ({ c, kinds: ManaSim.actionKinds(c.card) })).filter(x => x.kinds.length).map(({ c, kinds }) => {
    const by = (kinds.includes('fetch') ? r.play.seenBy : r.play.castBy)[c.card.name];
    return { name: c.card.name, qty: c.qty, kinds, r: by ? r2([3, 4, 5].map(t => by[t - 1])) : [0, 0, 0] };
  }).sort((a, b) => b.r[2] - a.r[2]);
  // 自分の効果で除去できるもの（行動干渉が届くかはアプリ側でカードタイプ・色・マナ総量・タフネスから判定する）
  const selfRm = Object.fromEntries([...new Set([...Object.keys(r.play.rmActs || {}), ...Object.keys(r.draw.rmActs || {})])]
    .map(n => { const c = rep.cards.find(x => x.card.name === n); return [n, c ? ManaSim.selfRemovalOf(c.card) : null]; }).filter(([, v]) => v));
  return { turns: [3, 4, 5], combos: combos.map(c => c.name), hasDisrupt: r.hasDisrupt, play: side(r.play), draw: side(r.draw), actCards, selfRm };
}

// ---------- メイン ----------
async function main() {
  const t0 = Date.now();
  const lookup = buildCardIndex(await loadOracle());
  console.log(`card index ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const defs = {};
  for (const [k, dir] of Object.entries(FORMATS)) defs[k] = loadDefs(path.join(args.formatdata, dir));

  const decksBy = Object.fromEntries(Object.keys(FORMATS).map(k => [k, []]));
  const unknownCards = Object.fromEntries(Object.keys(FORMATS).map(k => [k, new Map()]));
  const events = Object.fromEntries(Object.keys(FORMATS).map(k => [k, new Set()]));
  let files = 0;

  for (const file of walk(args.decks)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
    const t = pick(data, 'Tournament', 'tournament') || {};
    const date = new Date(String(pick(t, 'Date', 'date') || '').slice(0, 10));
    if (isNaN(date) || date < cutoff || date > today) continue;
    const fmt = formatOf(t, file);
    if (!fmt) continue;
    files++;
    const eventId = path.basename(file, '.json');
    const perArch = new Map();

    for (const d of pick(data, 'Decks', 'decks') || []) {
      const main = entries(pick(d, 'Mainboard', 'mainboard', 'main_board'));
      const side = entries(pick(d, 'Sideboard', 'sideboard', 'side_board'));
      const mainCount = main.reduce((s, e) => s + e.qty, 0);
      if (mainCount < 60) continue;

      const roles = Object.fromEntries(ROLE_IDS.map(r => [r, 0]));
      const colors = new Set();
      const cards = [];
      let mvSum = 0, nonLand = 0, missing = 0;
      const cats = Object.fromEntries(CAT_IDS.map(c => [c, 0]));
      const tagCounts = {};
      for (const e of main) {
        const card = lookup(e.name);
        if (!card) {
          missing += e.qty;
          unknownCards[fmt].set(e.name, (unknownCards[fmt].get(e.name) || 0) + 1);
          continue;
        }
        const info = Roles.inspect(card);
        const r = info.roles;
        r.forEach(x => { roles[x] += e.qty; });
        cats[info.cat] += e.qty;
        new Set(info.tags.map(t => `${t.effect}:${t.kind}`)).forEach(k => { tagCounts[k] = (tagCounts[k] || 0) + e.qty; });
        // インスタント速度のコンボパーツ（Goryo's Vengeance のような瞬間リアニメイト、インスタントの踏み倒しなど）
        //   主な採用理由がコンボ/展開・リソースのカードに限る（Flusterstorm のような妨害、Aether Vial のような継続的な展開は除く）
        const instantCombo = info.speed === 'instant' && (info.cat === 'combo' || info.cat === 'resource') && !r.includes('cheatloop') &&
          info.abilities.some(a => a.effects.some(x => ['cheat', 'extraturn'].includes(x)) ||
            (a.effects.includes('copy') && info.cat === 'combo') ||
            (a.effects.includes('recursion') && /to the battlefield/.test(a.text)));
        cards.push({ name: card.name, qty: e.qty, roles: r, cat: info.cat, tags: info.tags, power: card.power, typeLine: card.typeLine, instantCombo, oracle: card.oracle, card });
        if (!r.includes('land')) {
          nonLand += e.qty; mvSum += card.cmc * e.qty;
          (card.colors || []).forEach(c => colors.add(c));
        }
      }
      if (missing > 3) continue; // 判定できないカードが多いデッキは除外

      // 妨害の内訳（処理・対象の種類・選び方・速度）と、土地以外のパーマネントの構成
      const dp = Roles.disruptProfile(main.map(e => ({ qty: e.qty, card: lookup(e.name) })));
      const disrupt = {};
      for (const [k, v] of Object.entries(dp)) if (k !== 'total') for (const [kk, n] of Object.entries(v)) disrupt[`${k}:${kk}`] = n;
      const perm = { creature: 0, artifact: 0, enchantment: 0, planeswalker: 0 };
      for (const c of cards) {
        if (c.roles.includes('land')) continue;
        const front = String(c.typeLine).split(' // ')[0];
        for (const t of Object.keys(perm)) if (new RegExp(`\\b${t}\\b`, 'i').test(front)) perm[t] += c.qty;
      }

      const arch = Archetype.classify({ main, side }, defs[fmt], colors);
      const capKey = arch.name;
      const used = perArch.get(capKey) || 0;
      if (used >= MAX_PER_EVENT_ARCHETYPE) continue;
      perArch.set(capKey, used + 1);

      decksBy[fmt].push({
        archetype: arch.name, archetypeBase: arch.base, kind: arch.kind,
        roles, cats, tagCounts, disrupt, perm,
        combos: Combos.detect({ main }, roles.land).filter(x => x.complete).map(x => x.combo.id),
        avgMV: nonLand ? +(mvSum / nonLand).toFixed(2) : 0, mainCount, cards
      });
      events[fmt].add(eventId);
    }
  }
  console.log(`read ${files} event files`);

  fs.mkdirSync(path.join(OUT, 'archetypes'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'diagnostics'), { recursive: true });

  const sources = [
    { name: 'MTGO公開デッキリスト（fbettega/MTG_decklistcache 経由）', url: 'https://github.com/fbettega/MTG_decklistcache', license: 'GPL-3.0（集計値のみ使用・生データは再配布しない）' },
    { name: 'MTGOFormatData（アーキタイプ定義）', url: 'https://github.com/Badaro/MTGOFormatData', license: 'MIT' },
    { name: 'Scryfall（カードテキスト）', url: 'https://scryfall.com', license: 'Scryfall API利用規約' }
  ];
  const index = { generatedAt: new Date().toISOString(), window: { from: iso(cutoff), to: iso(today), days: DAYS }, sources, formats: {} };

  for (const fmt of Object.keys(FORMATS)) {
    const decks = decksBy[fmt];
    // アプリで使うアーキタイプ定義（帰属表示つき）
    fs.writeFileSync(path.join(OUT, 'archetypes', fmt + '.json'), JSON.stringify({
      source: sources[1], format: FORMATS[fmt], ...defs[fmt]
    }));

    const groups = new Map();
    decks.forEach(d => { if (!groups.has(d.archetype)) groups.set(d.archetype, []); groups.get(d.archetype).push(d); });
    const archetypes = [...groups.entries()]
      .map(([name, ds]) => ({
        name, base: ds[0].archetypeBase, kind: ds[0].kind,
        share: +(ds.length / (decks.length || 1)).toFixed(3),
        reference: ds.length < REFERENCE_THRESHOLD,
        ...summarizeGroup(ds),
        keyCards: keyCards(ds, 15)
      }))
      .sort((a, b) => b.n - a.n);

    // メタの特徴（アドバイス用）：アーキタイプごとに、何に頼っているデッキか
    const meta = archetypes.filter(a => a.n >= 5).map(a => {
      const ds = groups.get(a.name);
      const threats = threatsOf(ds);
      const comboCards = [...new Set(ds.flatMap(d => d.cards.filter(c => c.instantCombo).map(c => c.name)))]
        .filter(n => ds.filter(d => d.cards.some(c => c.name === n)).length / ds.length >= 0.5);
      return {
        name: a.name, share: a.share,
        artifact: a.perm.artifact.median >= 8,
        enchantment: a.perm.enchantment.median >= 6,
        planeswalker: a.perm.planeswalker.median >= 3,
        graveyard: a.roles.recursion.median >= 4 || (a.roles.recursion.median + a.roles.selfmill.median) >= 8,
        // 成立しているコンボと、その採用率（30%以上のもの）
        combos: Combos.list().map(c => ({ id: c.id, rate: +(ds.filter(d => d.combos.includes(c.id)).length / ds.length).toFixed(2) })).filter(x => x.rate >= 0.3),
        instantCombo: comboCards,
        // パーマネントの構成（中央値）と脅威カード、代表リストの一人回し
        perm: Object.fromEntries(Object.entries(a.perm).map(([k, v]) => [k, v.median])),
        threats,
        sim: simOf(ds)
      };
    });

    const bench = {
      format: FORMATS[fmt], generatedAt: index.generatedAt, window: index.window,
      events: events[fmt].size, sources,
      note: 'MTGOのChallenge上位とリーグ5-0のデッキのみ（フィールド全体ではなく「勝ったデッキ」の分布）',
      overall: summarizeGroup(decks),
      meta,
      archetypes
    };
    fs.writeFileSync(path.join(OUT, fmt + '.json'), JSON.stringify(bench));

    // 役割判定の見直し用
    const usage = new Map();
    decks.forEach(d => d.cards.forEach(c => {
      const e = usage.get(c.name) || { name: c.name, decks: 0, roles: c.roles, cat: c.cat, typeLine: c.typeLine, power: c.power };
      e.decks++; e.tags = c.tags; e.oracle = c.oracle; usage.set(c.name, e);
    }));
    const tagText = c => c.tags.map(t => `${t.effect}@${t.trigger}`);
    const all = [...usage.values()].sort((a, b) => b.decks - a.decks);
    // コンボ/展開のカードが多いのに、どのコンボ定義にも当てはまらないアーキタイプ（combos.json の登録候補）
    const comboCandidates = meta.filter(m => !m.combos.length)
      .map(m => archetypes.find(a => a.name === m.name))
      .filter(a => a && a.cats.combo && a.cats.combo.median >= 3)
      .map(a => ({ name: a.name, share: a.share, comboCards: a.keyCards.filter(k => k.cat === 'combo').map(k => k.name).slice(0, 8) }));
    // 墓地と追放（またはライブラリーの下）が書いてあるのに墓地対策が付いていないカード。自分の墓地のコスト（探査・脱出など）は除く
    const gyMiss = all.filter(c => {
      if (c.roles.includes('gyhate')) return false;
      const o = String(c.oracle || '').toLowerCase().replace(/\([^)]*\)/g, '');
      const t = o.replace(/[^.\n]*from your graveyard[^.\n]*/g, '').replace(/\b(delve|escape|flashback|unearth|embalm|eternalize|retrace|jump-start|disturb)\b[^.\n]*/g, '');
      return /graveyard/.test(t) && /(exile|bottom of|can't)/.test(t);
    }).slice(0, 60).map(c => ({ name: c.name, decks: c.decks, roles: c.roles, oracle: c.oracle }));
    // 効果を読み取れなかった能力の文（採用の多いカードから）。カード名は ~、数字は N にまとめて書き方ごとに集計する
    const untaggedLines = new Map();
    for (const c of all.slice(0, 600)) {
      const card = lookup(c.name);
      if (!card) continue;
      const nm = String(card.name).split(' // ')[0].toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const u of Tags.analyze(card).untagged || []) {
        const key = u.text.replace(new RegExp(nm, 'g'), '~').replace(/\b\d+\b/g, 'N');
        const e = untaggedLines.get(key) || { pattern: key, kind: u.kind, decks: 0, cards: [] };
        e.decks += c.decks; if (e.cards.length < 4) e.cards.push(c.name);
        untaggedLines.set(key, e);
      }
    }
    const untagged = [...untaggedLines.values()].sort((a, b) => b.decks - a.decks).slice(0, 200);
    const diag = {
      untagged,
      comboCandidates,
      gyhateCandidates: gyMiss,
      // 妨害の小カテゴリごとの判定根拠（オラクルテキストと、処理・対象の種類）。判定ルールの見直し用
      disruptEvidence: Object.fromEntries(['removal', 'wipe', 'spell', 'ability', 'action', 'discard', 'gyhate', 'manalock', 'combat'].map(id => [id,
        all.filter(c => c.roles.includes(id)).slice(0, 40).map(c => ({ name: c.name, decks: c.decks, oracle: c.oracle,
          detail: c.tags.filter(t => t.detail).map(t => `${t.effect}:${t.detail.action}:${t.detail.types.join('/')}`) }))])),
      format: FORMATS[fmt], generatedAt: index.generatedAt, decks: decks.length,
      // 「その他」としか判定されなかった採用率の高いカード → ルール追加の候補
      otherOnly: all.filter(c => c.cat === 'other').slice(0, 60).map(c => ({ name: c.name, decks: c.decks, typeLine: c.typeLine, tags: tagText(c) })),
      // 役割を3つ以上持つカード → 判定が広すぎる可能性
      manyRoles: all.filter(c => c.roles.length >= 3).slice(0, 30).map(c => ({ name: c.name, decks: c.decks, roles: c.roles, tags: tagText(c) })),
      // 大カテゴリごとの採用率上位（主な採用理由の判定確認用）
      byCategory: Object.fromEntries(CAT_IDS.map(cat => [cat, all.filter(c => c.cat === cat && cat !== 'mana').slice(0, 25).map(c => ({ name: c.name, decks: c.decks, roles: c.roles }))]).filter(([cat]) => cat !== 'mana')),
      // エンジン・フィニッシャーと判定されたカード（判定の確認用）
      damage: all.filter(c => c.cat === 'damage').slice(0, 40).map(c => ({ name: c.name, decks: c.decks, roles: c.roles, tags: tagText(c) })),
      // タグが1つも付かなかった土地以外のカード → 効果の判定漏れの候補
      noTags: all.filter(c => !c.roles.includes('land') && !c.tags.length).slice(0, 40).map(c => ({ name: c.name, decks: c.decks, roles: c.roles, typeLine: c.typeLine })),
      unknownCards: [...unknownCards[fmt].entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, decks]) => ({ name, decks })),
      unclassifiedDecks: decks.filter(d => d.kind === 'unknown').length
    };
    fs.writeFileSync(path.join(OUT, 'diagnostics', fmt + '.json'), JSON.stringify(diag, null, 1));

    index.formats[fmt] = { label: FORMATS[fmt], decks: decks.length, events: events[fmt].size, archetypes: archetypes.length };
    console.log(`${FORMATS[fmt]}: ${decks.length} decks / ${events[fmt].size} events / ${archetypes.length} archetypes`);
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
