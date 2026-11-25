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
const CardModel = require(path.join(ROOT, 'js/cardmodel.js'));
const Archetype = require(path.join(ROOT, 'js/archetype.js'));

const FORMATS = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern',
  legacy: 'Legacy', vintage: 'Vintage', pauper: 'Pauper'
};
const ROLE_IDS = Roles.ROLES.map(r => r.id);
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
  out.roles.interaction = summarize(decks.map(d => d.interaction));
  out.avgMV = summarize(decks.map(d => d.avgMV));
  out.mainCount = summarize(decks.map(d => d.mainCount));
  return out;
}
function keyCards(decks, limit) {
  const m = new Map();
  for (const d of decks) for (const c of d.cards) {
    if (c.roles.includes('land')) continue;
    const e = m.get(c.name) || { name: c.name, decks: 0, copies: 0, roles: c.roles };
    e.decks++; e.copies += c.qty; m.set(c.name, e);
  }
  return [...m.values()].sort((a, b) => b.decks - a.decks || b.copies - a.copies).slice(0, limit)
    .map(e => ({ name: e.name, rate: +(e.decks / decks.length).toFixed(2), avg: +(e.copies / e.decks).toFixed(2), roles: e.roles }));
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
      for (const e of main) {
        const card = lookup(e.name);
        if (!card) {
          missing += e.qty;
          unknownCards[fmt].set(e.name, (unknownCards[fmt].get(e.name) || 0) + 1);
          continue;
        }
        const r = Roles.classify(card);
        r.forEach(x => { roles[x] += e.qty; });
        cards.push({ name: card.name, qty: e.qty, roles: r, power: card.power, typeLine: card.typeLine });
        if (!r.includes('land')) {
          nonLand += e.qty; mvSum += card.cmc * e.qty;
          (card.colors || []).forEach(c => colors.add(c));
        }
      }
      if (missing > 3) continue; // 判定できないカードが多いデッキは除外

      const arch = Archetype.classify({ main, side }, defs[fmt], colors);
      const capKey = arch.name;
      const used = perArch.get(capKey) || 0;
      if (used >= MAX_PER_EVENT_ARCHETYPE) continue;
      perArch.set(capKey, used + 1);

      decksBy[fmt].push({
        archetype: arch.name, archetypeBase: arch.base, kind: arch.kind,
        roles, interaction: roles.removal + roles.wipe + roles.counter,
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

    const bench = {
      format: FORMATS[fmt], generatedAt: index.generatedAt, window: index.window,
      events: events[fmt].size, sources,
      note: 'MTGOのChallenge上位とリーグ5-0のデッキのみ（フィールド全体ではなく「勝ったデッキ」の分布）',
      overall: summarizeGroup(decks),
      archetypes
    };
    fs.writeFileSync(path.join(OUT, fmt + '.json'), JSON.stringify(bench));

    // 役割判定の見直し用
    const usage = new Map();
    decks.forEach(d => d.cards.forEach(c => {
      const e = usage.get(c.name) || { name: c.name, decks: 0, roles: c.roles, typeLine: c.typeLine, power: c.power };
      e.decks++; usage.set(c.name, e);
    }));
    const all = [...usage.values()].sort((a, b) => b.decks - a.decks);
    const diag = {
      format: FORMATS[fmt], generatedAt: index.generatedAt, decks: decks.length,
      // 「その他」としか判定されなかった採用率の高いカード → ルール追加の候補
      otherOnly: all.filter(c => c.roles.length === 1 && c.roles[0] === 'other').slice(0, 60),
      // 役割を3つ以上持つカード → 判定が広すぎる可能性
      manyRoles: all.filter(c => c.roles.length >= 3).slice(0, 30),
      // 脅威と判定された低パワーのクリーチャー → 過剰判定の候補
      weakThreats: all.filter(c => c.roles.includes('threat') && /Creature/.test(c.typeLine) && Number(c.power) <= 1).slice(0, 30),
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
