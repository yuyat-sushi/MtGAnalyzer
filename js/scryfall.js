/*
 * Scryfall API クライアント
 * - 全リクエストを1本のキューに通し、最低 REQUEST_INTERVAL_MS の間隔を空ける
 *   （Scryfall推奨: 1リクエストあたり50〜100ms、平均10req/s以下）
 * - 429 (Too Many Requests) を受けたら指数バックオフで再試行
 * - 取得したカードは localStorage に24時間キャッシュ（Scryfall推奨のキャッシュ期間）
 * - デッキ読込は /cards/collection で最大75枚ずつまとめて取得し、リクエスト数を最小化
 */
(function (global) {
  'use strict';

  const API = 'https://api.scryfall.com';
  const REQUEST_INTERVAL_MS = 120;      // 余裕を持って 約8req/s
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_PREFIX = 'mtga.card.';
  const CACHE_INDEX = 'mtga.cardIndex'; // 名前の別名 → 正規名
  const MAX_RETRY = 4;

  // ---------- リクエストキュー ----------
  const queue = [];
  let running = false;
  let lastRequestAt = 0;
  const listeners = new Set();
  let stats = { sent: 0, cacheHits: 0, pending: 0 };

  function notify() { stats.pending = queue.length; listeners.forEach(fn => fn({ ...stats })); }
  function onStats(fn) { listeners.add(fn); fn({ ...stats }); }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function enqueue(url, options) {
    return new Promise((resolve, reject) => {
      queue.push({ url, options, resolve, reject, tries: 0 });
      notify();
      pump();
    });
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue[0];
      const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      stats.sent++;
      try {
        const res = await fetch(job.url, {
          ...job.options,
          headers: { 'Accept': 'application/json', ...(job.options && job.options.headers) }
        });
        if (res.status === 429 && job.tries < MAX_RETRY) {
          job.tries++;
          const retryAfter = Number(res.headers.get('Retry-After'));
          const backoff = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** job.tries;
          console.warn('[scryfall] 429 受信。' + backoff + 'ms 待機して再試行');
          lastRequestAt = Date.now() + backoff; // キュー全体を止める
          continue;
        }
        queue.shift();
        const body = await res.json().catch(() => null);
        if (!res.ok && res.status !== 404) {
          job.reject(new Error((body && body.details) || ('HTTP ' + res.status)));
        } else {
          job.resolve({ status: res.status, body });
        }
      } catch (err) {
        queue.shift();
        job.reject(err);
      }
      notify();
    }
    running = false;
    notify();
  }

  // ---------- キャッシュ ----------
  const norm = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function readIndex() {
    try { return JSON.parse(localStorage.getItem(CACHE_INDEX) || '{}'); } catch (e) { return {}; }
  }
  let aliasIndex = readIndex();
  function saveIndex() {
    try { localStorage.setItem(CACHE_INDEX, JSON.stringify(aliasIndex)); } catch (e) { /* 容量超過は無視 */ }
  }

  function cacheGet(name) {
    const key = aliasIndex[norm(name)] || norm(name);
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (Date.now() - entry.t > CACHE_TTL_MS) return null;
      return entry.c;
    } catch (e) { return null; }
  }

  function cachePut(card, ...aliases) {
    const key = norm(card.name);
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), c: card }));
    } catch (e) {
      pruneCache();
      try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), c: card })); } catch (e2) { /* 諦める */ }
    }
    aliasIndex[key] = key;
    if (card.faceNames) card.faceNames.forEach(f => { aliasIndex[norm(f)] = key; });
    // MTGO表記ゆれ（"Fire/Ice" "Fire / Ice"）も同じカードとして引けるようにする
    aliasIndex[norm(card.name.replace(/ \/\/ /g, '/'))] = key;
    aliasIndex[norm(card.name.replace(/ \/\/ /g, ' / '))] = key;
    if (card.printedName) aliasIndex[norm(card.printedName)] = key;
    aliases.filter(Boolean).forEach(a => { aliasIndex[norm(a)] = key; });
    saveIndex();
  }

  function pruneCache() {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(CACHE_PREFIX)) continue;
      try {
        const e = JSON.parse(localStorage.getItem(k));
        if (now - e.t > CACHE_TTL_MS) localStorage.removeItem(k);
      } catch (err) { localStorage.removeItem(k); }
    }
  }

  function clearCache() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
    aliasIndex = {};
    saveIndex();
  }

  // ---------- カードデータの圧縮（必要な項目だけ保存） ----------
  function slim(c) {
    const faces = c.card_faces || [];
    const img = c.image_uris || (faces[0] && faces[0].image_uris) || {};
    const oracle = c.oracle_text != null
      ? c.oracle_text
      : faces.map(f => f.oracle_text || '').join('\n//\n');
    return {
      id: c.id,
      name: c.name,
      printedName: c.printed_name || (faces[0] && faces[0].printed_name) || null,
      faceNames: faces.map(f => f.name),
      cmc: c.cmc || 0,
      manaCost: c.mana_cost != null ? c.mana_cost : faces.map(f => f.mana_cost || '').join(' // '),
      typeLine: c.type_line || faces.map(f => f.type_line).join(' // '),
      oracle,
      colors: c.colors || (faces[0] && faces[0].colors) || [],
      colorIdentity: c.color_identity || [],
      producedMana: c.produced_mana || [],
      keywords: c.keywords || [],
      power: c.power != null ? c.power : (faces[0] && faces[0].power) || null,
      layout: c.layout,
      mtgoId: c.mtgo_id || null,
      set: c.set,
      rarity: c.rarity,
      legalities: c.legalities || {},
      img: img.normal || null,
      imgSmall: img.small || null,
      uri: c.scryfall_uri
    };
  }

  // ---------- 公開API ----------

  /** 名前の配列を受け取り、{ found: Map(入力名→card), notFound: [] } を返す */
  async function fetchCardsByName(names, onProgress) {
    const found = new Map();
    const missing = [];
    for (const n of names) {
      const hit = cacheGet(n);
      if (hit) { found.set(n, hit); stats.cacheHits++; } else missing.push(n);
    }
    notify();

    const notFound = [];
    // 75枚ずつ /cards/collection
    for (let i = 0; i < missing.length; i += 75) {
      const chunk = missing.slice(i, i + 75);
      const identifiers = chunk.map(n => ({ name: lookupName(n) }));
      const { body } = await enqueue(API + '/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers })
      });
      const data = (body && body.data) || [];
      // 返ってきたカードを入力名に対応づける
      const byNorm = new Map();
      data.forEach(raw => {
        const card = slim(raw);
        const keys = [card.name, ...(card.faceNames || []), card.name.split(' // ')[0]];
        keys.forEach(k => byNorm.set(norm(k), card));
      });
      chunk.forEach(n => {
        const card = byNorm.get(norm(lookupName(n))) || byNorm.get(norm(lookupName(n).split(' // ')[0]));
        if (card) { cachePut(card, n); found.set(n, card); }
        else notFound.push(n);
      });
      if (onProgress) onProgress(Math.min(i + 75, missing.length), missing.length);
    }

    // collection で見つからなかったものは fuzzy 検索で1枚ずつ救済（キュー経由）
    const stillMissing = [];
    for (const n of notFound) {
      const card = await fetchNamed(n, true).catch(() => null);
      if (card) found.set(n, card); else stillMissing.push(n);
    }
    return { found, notFound: stillMissing };
  }

  // MTGO表記 "Fire/Ice" → Scryfall表記 "Fire // Ice"
  function lookupName(n) {
    let s = String(n).trim();
    if (/[^/]\/[^/]/.test(s) && !s.includes('//')) s = s.replace(/\s*\/\s*/, ' // ');
    return s;
  }

  async function fetchNamed(name, fuzzy) {
    const hit = cacheGet(name);
    if (hit) { stats.cacheHits++; notify(); return hit; }
    const param = fuzzy ? 'fuzzy' : 'exact';
    const { status, body } = await enqueue(API + '/cards/named?' + param + '=' + encodeURIComponent(lookupName(name)));
    if (status === 404 || !body || body.object === 'error') return null;
    const card = slim(body);
    cachePut(card, name);
    return card;
  }

  /** 検索（日本語名も可）。最大 limit 件 */
  async function search(query, limit = 30) {
    const isJa = /[぀-ヿ一-龯]/.test(query);
    const q = isJa ? `${query} lang:ja` : query;
    const url = API + '/cards/search?unique=cards&order=name&include_multilingual=' + (isJa ? 'true' : 'false') +
      '&q=' + encodeURIComponent(q);
    const { status, body } = await enqueue(url);
    if (status === 404 || !body || !body.data) return [];
    return body.data.slice(0, limit).map(raw => {
      const card = slim(raw);
      // 日本語版で取れた場合も、英語名をキーにキャッシュ
      cachePut(card, card.printedName);
      return card;
    });
  }

  /** 入力補完（英語名） */
  async function autocomplete(text) {
    if (!text || text.length < 2) return [];
    const { body } = await enqueue(API + '/cards/autocomplete?q=' + encodeURIComponent(text));
    return (body && body.data) || [];
  }

  pruneCache();

  global.Scryfall = { fetchCardsByName, fetchNamed, search, autocomplete, onStats, clearCache, lookupName };
})(window);
