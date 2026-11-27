/* MtG Analyzer メインアプリ */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const STORE_CURRENT = 'mtga.current';
  const STORE_SAVED = 'mtga.saved';

  // ---------- 状態 ----------
  // entry: { name, qty, card (Scryfall slim) | null, manualRoles: string[] | null, missing?: bool }
  let state = loadCurrent() || blankDeck();
  let groupMode = 'role';

  function blankDeck() {
    return { name: '', format: 'constructed', archetype: 'midrange', meta: '', metaArch: 'auto', main: [], side: [] };
  }

  function rolesOf(e) {
    if (e.manualRoles && e.manualRoles.length) {
      const r = Roles.normalizeRoles(e.manualRoles); // 旧バージョンの小カテゴリは新しいIDに読み替える
      if (r.length) return r;
    }
    return Roles.classify(e.card);
  }

  /** 大カテゴリ（主な採用理由）: 手動指定 ＞ 手動の小カテゴリから決めたもの ＞ 自動判定（例外リスト込み） */
  function catOf(e) {
    if (e.manualCat && Roles.CAT_MAP[e.manualCat]) return e.manualCat;
    if (e.manualRoles && e.manualRoles.length) {
      const r = Roles.normalizeRoles(e.manualRoles);
      if (r.length) return Roles.categoryOf(r);
    }
    return Roles.inspect(e.card).cat;
  }

  // ---------- 永続化 ----------
  function serialize(deck) {
    // カードデータ本体は Scryfall キャッシュ側にあるので、名前と手動役割だけ保存
    const z = l => l.map(e => ({ name: e.name, qty: e.qty, manualRoles: e.manualRoles || null, manualCat: e.manualCat || null }));
    return { name: deck.name, format: deck.format, archetype: deck.archetype, meta: deck.meta || '', metaArch: deck.metaArch || 'auto', main: z(deck.main), side: z(deck.side) };
  }
  function saveCurrent() {
    try { localStorage.setItem(STORE_CURRENT, JSON.stringify(serialize(state))); } catch (e) { /* noop */ }
  }
  function loadCurrent() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_CURRENT));
      if (!d) return null;
      d.main = (d.main || []).map(e => ({ ...e, card: null }));
      d.side = (d.side || []).map(e => ({ ...e, card: null }));
      return d;
    } catch (e) { return null; }
  }
  function savedDecks() {
    try { return JSON.parse(localStorage.getItem(STORE_SAVED)) || {}; } catch (e) { return {}; }
  }

  // ---------- カード解決 ----------
  async function resolveCards() {
    const all = [...state.main, ...state.side].filter(e => !e.card);
    if (!all.length) return;
    const names = [...new Set(all.map(e => e.name))];
    setStatus(`カード情報を取得中…（${names.length} 種類）`);
    try {
      const { found, notFound } = await Scryfall.fetchCardsByName(names, (done, total) => {
        setStatus(`カード情報を取得中… ${done}/${total}`);
      });
      for (const e of all) {
        const c = found.get(e.name);
        if (c) { e.card = c; e.name = c.name; e.missing = false; } else e.missing = true;
      }
      mergeDuplicates();
      if (notFound.length) toast(`見つからなかったカード: ${notFound.join(', ')}`);
      setStatus('準備OK');
    } catch (err) {
      setStatus('取得エラー: ' + err.message);
      toast('Scryfall からの取得に失敗しました: ' + err.message);
    }
    render();
  }

  function mergeDuplicates() {
    for (const zone of ['main', 'side']) {
      const map = new Map();
      for (const e of state[zone]) {
        const k = e.name.toLowerCase();
        if (map.has(k)) map.get(k).qty += e.qty; else map.set(k, e);
      }
      state[zone] = [...map.values()];
    }
  }

  // ---------- デッキ操作 ----------
  function addCard(card, zone = 'main', qty = 1) {
    const list = state[zone];
    const ex = list.find(e => e.name === card.name);
    if (ex) { ex.qty += qty; ex.card = ex.card || card; }
    else list.push({ name: card.name, qty, card, manualRoles: null });
    render();
    flashStatus(`${displayName(card)} を${zone === 'main' ? 'メイン' : 'サイド'}に追加`);
  }

  function changeQty(zone, name, delta) {
    const list = state[zone];
    const e = list.find(x => x.name === name);
    if (!e) return;
    e.qty += delta;
    if (e.qty <= 0) state[zone] = list.filter(x => x !== e);
    render();
  }

  function moveZone(zone, name) {
    const other = zone === 'main' ? 'side' : 'main';
    const e = state[zone].find(x => x.name === name);
    if (!e) return;
    changeQty(zone, name, -1);
    const ex = state[other].find(x => x.name === name);
    if (ex) ex.qty++; else state[other].push({ ...e, qty: 1 });
    render();
  }

  function importDeck(text, filename, append) {
    const parsed = DeckIO.parseAuto(text, filename);
    const count = parsed.main.length + parsed.side.length;
    if (!count) { toast('カードを読み取れませんでした。MTGO形式か確認してね。'); return; }
    if (!append) {
      state.main = []; state.side = [];
      if (filename) state.name = filename.replace(/\.(txt|dek)$/i, '');
    }
    for (const zone of ['main', 'side']) {
      for (const p of parsed[zone]) {
        const ex = state[zone].find(e => e.name.toLowerCase() === p.name.toLowerCase());
        if (ex) ex.qty += p.qty; else state[zone].push({ name: p.name, qty: p.qty, card: null, manualRoles: null });
      }
    }
    // 枚数から統率者戦を推定
    const total = parsed.main.reduce((s, e) => s + e.qty, 0) + parsed.side.reduce((s, e) => s + e.qty, 0);
    if (!append && total >= 95 && total <= 101 && parsed.side.length <= 2) state.format = 'commander';
    else if (!append && total <= 45) state.format = 'limited';
    render();
    resolveCards();
  }

  function exportEntries(zone) {
    return state[zone].map(e => ({ name: e.name, qty: e.qty, mtgoId: e.card && e.card.mtgoId }));
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  const safeFileName = () => (state.name || 'deck').replace(/[\\/:*?"<>|]/g, '_');

  // ---------- 表示ヘルパ ----------
  function displayName(card) {
    return card.printedName ? `${card.printedName}` : card.name;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function manaHTML(cost) {
    if (!cost) return '';
    const front = cost.split(' // ')[0];
    const syms = front.match(/\{[^}]+\}/g) || [];
    return '<span class="mana">' + syms.map(s => {
      const code = s.slice(1, -1).replace(/\//g, '');
      return `<img src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(code)}.svg" alt="${esc(s)}" loading="lazy">`;
    }).join('') + '</span>';
  }
  function chipsHTML(e) {
    const roles = rolesOf(e);
    const manual = !!((e.manualRoles && e.manualRoles.length) || e.manualCat);
    const back = e.card ? Roles.inspect(e.card).back : null;
    const ult = e.card ? Roles.inspect(e.card).ult : null;
    return roles.map(r => {
      const R = Roles.ROLE_MAP[r];
      return `<span class="chip ${manual ? 'manual' : ''}" style="background:${R.color}">${R.label}</span>`;
    }).join('') + (back && back.roles.length ? back.roles.map(r => {
      const R = Roles.ROLE_MAP[r];
      return `<span class="chip back" title="変身後の役割（枚数には数えない）">変身後:${R.label}</span>`;
    }).join('') : '') + (ult && ult.roles.length ? ult.roles.map(r => {
      const R = Roles.ROLE_MAP[r];
      return `<span class="chip back" title="奥義（出たターンに使えない忠誠度能力。枚数には数えない）">奥義:${R.label}</span>`;
    }).join('') : '');
  }

  function typeGroup(card) {
    if (!card) return '不明';
    const t = String(card.typeLine).split('//')[0];
    for (const [k, v] of [['Land', '土地'], ['Creature', 'クリーチャー'], ['Planeswalker', 'プレインズウォーカー'], ['Battle', 'バトル'],
      ['Instant', 'インスタント'], ['Sorcery', 'ソーサリー'], ['Artifact', 'アーティファクト'], ['Enchantment', 'エンチャント']]) {
      if (t.includes(k)) return v;
    }
    return 'その他';
  }

  // ---------- 描画 ----------
  function render() {
    saveCurrent();
    $('#deckName').value = state.name || '';
    $('#format').value = state.format;
    $('#archetype').value = state.archetype;
    $('#archetype').disabled = state.format !== 'constructed';
    $('#metaFormat').value = state.meta || '';
    if (!state.metaArch) state.metaArch = 'auto';
    fillArchSelect();

    const mainN = state.main.reduce((s, e) => s + e.qty, 0);
    const sideN = state.side.reduce((s, e) => s + e.qty, 0);
    $('#mainCount').textContent = mainN;
    $('#tabCount').textContent = mainN;
    $('#sideCount').textContent = 'SB ' + sideN;

    renderList($('#deckList'), state.main, 'main', true);
    renderList($('#sideList'), state.side, 'side', false);
    renderAnalysis();
  }

  function renderList(root, list, zone, grouped) {
    if (!list.length) {
      root.innerHTML = `<div class="empty">${zone === 'main' ? 'カードを検索して追加するか、MTGO形式のデッキをインポートしてね' : 'サイドボードは空です'}</div>`;
      return;
    }
    let groups;
    if (!grouped) groups = [{ key: 'side', label: '', color: null, items: list }];
    else if (groupMode === 'role') {
      groups = Roles.CATEGORIES.map(c => ({
        key: c.id, label: c.label, color: c.color,
        items: list.filter(e => catOf(e) === c.id)
      }));
    } else if (groupMode === 'type') {
      const order = ['クリーチャー', 'プレインズウォーカー', 'バトル', 'インスタント', 'ソーサリー', 'アーティファクト', 'エンチャント', 'その他', '土地', '不明'];
      groups = order.map(k => ({ key: k, label: k, color: null, items: list.filter(e => typeGroup(e.card) === k) }));
    } else {
      const label = i => i === 7 ? 'MV 7+' : 'MV ' + i;
      groups = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({
        key: 'mv' + i, label: label(i), color: null,
        items: list.filter(e => e.card && !rolesOf(e).includes('land') && Math.min(7, Math.floor(e.card.cmc)) === i)
      }));
      groups.push({ key: 'land', label: '土地', color: null, items: list.filter(e => rolesOf(e).includes('land')) });
      groups.push({ key: 'unk', label: '不明', color: null, items: list.filter(e => !e.card) });
    }

    root.innerHTML = groups.filter(g => g.items.length).map(g => {
      const n = g.items.reduce((s, e) => s + e.qty, 0);
      const items = [...g.items].sort((a, b) => ((a.card && a.card.cmc) || 0) - ((b.card && b.card.cmc) || 0) || a.name.localeCompare(b.name));
      return `<div class="group">
        ${g.label ? `<div class="group-head">${g.color ? `<span class="dot" style="background:${g.color}"></span>` : ''}${esc(g.label)} <span class="n">${n}</span></div>` : ''}
        ${items.map(e => rowHTML(e, zone)).join('')}
      </div>`;
    }).join('');
  }

  function rowHTML(e, zone) {
    const c = e.card;
    const label = c ? displayName(c) : e.name;
    const sub = c && c.printedName ? `<small>${esc(c.name)}</small>` : '';
    return `<div class="row ${e.missing ? 'missing' : ''}" data-zone="${zone}" data-name="${esc(e.name)}">
      <div class="qty">
        <button data-act="dec" title="減らす">−</button><span>${e.qty}</span><button data-act="inc" title="増やす">＋</button>
      </div>
      <div class="name" data-preview>${esc(label)}${sub}${e.missing ? ' <small>(未取得)</small>' : ''}</div>
      <div class="meta">
        ${c ? manaHTML(c.manaCost) : ''}
        <span class="chips" data-act="roles" title="クリックで役割を編集">${c || e.manualRoles ? chipsHTML(e) : ''}</span>
        <button class="move" data-act="move" title="${zone === 'main' ? 'サイドへ1枚移動' : 'メインへ1枚移動'}">${zone === 'main' ? '→SB' : '→Main'}</button>
      </div>
    </div>`;
  }

  const openCats = new Set();
  let extraOpen = false;
  const openArch = new Set();
  /** 小カテゴリの横に添える大事な属性（例: 単体除去 12（追放 4）、呪文への干渉 6（継続 2）） */
  function subNote(id) {
    const count = pred => state.main.filter(e => e.card && rolesOf(e).includes(id) && Roles.inspect(e.card).tags.some(pred)).reduce((s, e) => s + e.qty, 0);
    const d = t => t.detail || {};
    let n = 0, label = '';
    if (id === 'removal' || id === 'wipe') { n = count(t => (t.effect === 'removal' || t.effect === 'wipe') && d(t).action === 'exile'); label = '追放'; }
    else if (['spell', 'ability', 'manalock', 'combat'].includes(id)) { n = count(t => t.detail && t.repeat); label = '継続'; }
    else if (id === 'discard' || id === 'gyhate') { n = count(t => t.detail && t.speed === 'instant'); label = 'インスタント'; }
    return n ? `<span class="muted">（${label} ${n}）</span>` : '';
  }
  function renderAnalysis() {
    const entries = state.main.map(e => ({ qty: e.qty, card: e.card, roles: rolesOf(e), cat: catOf(e) }));
    const cmp = metaComparison();
    const a = Roles.analyze(entries, state.format, state.archetype, cmp && cmp.group ? { targets: cmp.targets, label: cmp.label } : null);
    renderMeta(cmp, a);
    renderTags(a, cmp && cmp.group);

    // カテゴリ構成（大カテゴリ → 小カテゴリ）
    const maxScale = Math.max(a.size * 0.45, ...Object.values(a.catCount), ...Object.values(a.roleCount));
    const pct = x => Math.min(100, (x / maxScale) * 100);
    const tgtFor = id => (id === 'land' && !(cmp && cmp.group)) ? [Math.floor(a.recLand - 1), Math.ceil(a.recLand + 1)] : a.targets[id];
    const bar = (label, v, t, color, cls = '') => `<div class="rb ${cls}">
        <span>${label}</span>
        <div class="rb-track">
          ${t ? `<div class="rb-target" style="left:${pct(t[0])}%;width:${Math.max(0.5, pct(t[1]) - pct(t[0]))}%"></div>` : ''}
          <div class="rb-fill" style="width:${pct(v)}%;background:${color}"></div>
        </div>
        <span class="rb-val">${v}${t ? ` <span class="t">/ ${t[0]}–${t[1]}</span>` : ''}</span>
      </div>`;
    const cats = Roles.CATEGORIES.filter(c => c.id !== 'other' || a.catCount.other).map(c => {
      const subs = Roles.ROLES.filter(r => r.cat === c.id && r.id !== 'other');
      const subRows = subs.filter(r => (a.roleCount[r.id] || 0) || (a.total && tgtFor(r.id) && tgtFor(r.id)[1] > 0)).map(r =>
        bar(r.label + subNote(r.id), a.roleCount[r.id] || 0, a.total ? tgtFor(r.id) : null, r.color, 'sub')).join('');
      const head = bar(`<b>${c.label}</b>`, a.catCount[c.id] || 0, a.total ? a.targets['cat:' + c.id] : null, c.color, 'cat');
      return subRows
        ? `<details class="cat-detail" data-cat="${c.id}" ${openCats.has(c.id) ? 'open' : ''}><summary>${head}</summary>${subRows}</details>`
        : `<div class="cat-detail">${head}</div>`;
    }).join('');
    const stack = a.total ? `<div class="stack" title="大カテゴリの構成比">${Roles.CATEGORIES.map(c => {
      const v = a.catCount[c.id];
      return v ? `<div style="width:${v / a.total * 100}%;background:${c.color}" title="${c.label} ${v}枚 (${(v / a.total * 100).toFixed(0)}%)"></div>` : '';
    }).join('')}</div>` : '';
    $('#roleBars').innerHTML = stack + cats +
      `<p class="hint">太字＝大カテゴリ（主な採用理由。1枚につき1つ）、押すと小カテゴリ（1枚に複数可）を表示。点線の枠＝${cmp && cmp.group ? `上位デッキ（${esc(cmp.label)}）の中央50%の範囲` : 'フォーマット/アーキタイプ別の目安'}。</p>`;
    $('#roleBars').querySelectorAll('details.cat-detail').forEach(d => d.addEventListener('toggle', () => {
      if (d.open) openCats.add(d.dataset.cat); else openCats.delete(d.dataset.cat);
    }));

    // マナカーブ
    const cmax = Math.max(1, ...a.curve);
    $('#curve').innerHTML = a.curve.map((v, i) => `<div class="cbar">
        <span class="v">${v || ''}</span>
        <div class="b" style="height:${v / cmax * 100}%"></div>
        <span class="l">${i === 7 ? '7+' : i}</span>
      </div>`).join('');
    $('#avgMV').textContent = a.nonLand ? `平均MV ${a.avgMV.toFixed(2)}（土地除く ${a.nonLand} 枚）` : '';
    const simTips = renderManaSim();

    // 色
    const totalPips = Object.values(a.pips).reduce((s, x) => s + x, 0);
    const totalSrc = Object.values(a.sources).reduce((s, x) => s + x, 0);
    const colorRows = ['W', 'U', 'B', 'R', 'G'].filter(c => a.pips[c] || a.sources[c]).map(c => {
      const p = totalPips ? a.pips[c] / totalPips * 100 : 0;
      const s = totalSrc ? a.sources[c] / totalSrc * 100 : 0;
      return `<div class="crow">
        <img src="https://svgs.scryfall.io/card-symbols/${c}.svg" alt="${Roles.COLOR_JA[c]}">
        <div class="cbarh"><div style="width:${p}%;background:var(--gold)"></div><span>${a.pips[c]}</span></div>
        <div class="cbarh"><div style="width:${s}%;background:#6aa0d8"></div><span>${Math.round(a.sources[c] * 10) / 10}</span></div>
      </div>`;
    }).join('');
    $('#colors').innerHTML = colorRows
      ? `<div class="legend"><span>■ <span style="color:var(--gold)">色シンボル</span></span><span>■ <span style="color:#6aa0d8">色源（土地＋加速×0.5）</span></span></div>${colorRows}`
      : '<p class="hint">色のあるカードがまだありません</p>';

    // アドバイス
    // 妨害の内訳と、メタに応じたアドバイス
    const toEntries = l => l.map(e => ({ qty: e.qty, card: e.card }));
    const dMain = Roles.disruptProfile(toEntries(state.main)), dSide = Roles.disruptProfile(toEntries(state.side));
    renderDisrupt(dMain, dSide, cmp && cmp.group);
    const metaTips = cmp && cmp.bench && cmp.bench.meta ? Roles.metaAdvice(dMain, dSide, cmp.bench.meta, cmp.group) : [];
    metaTips.push(...renderCombos(cmp));
    metaTips.push(...renderMatchups(cmp));
    const all = [...a.advice, ...metaTips.map(x => ({ group: 'meta', ...x })), ...simTips.map(x => ({ group: 'plan', ...x }))];
    const GROUPS = [
      ['base', '前提チェック（枚数・土地・色）'],
      ['plan', 'メインの動き（一人回し）'],
      ['meta', '環境への対策'],
      ['extra', '参考：上位デッキ・目安との構成の違い']
    ];
    $('#advice').innerHTML = GROUPS.map(([g, label]) => {
      const items = all.filter(x => (x.group || 'base') === g);
      if (!items.length) return '';
      const lis = items.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('');
      // 構成の比率は参考情報なので折りたたむ
      if (g === 'extra') return `<li class="adv-extra"><details${extraOpen ? ' open' : ''}><summary>${label}（${items.length}件）</summary><ul class="advice">${lis}</ul></details></li>`;
      return `<li class="adv-head">${label}</li>` + lis;
    }).join('');
    const ex = $('#advice details');
    if (ex) ex.addEventListener('toggle', () => { extraOpen = ex.open; });
  }

  // ---------- マナシミュレーション（js/manasim.js） ----------
  // 計算に少し時間がかかるので、デッキが変わったら後から計算して描き直す
  let simCache = { sig: null, result: null, pending: false };
  const pctTxt = x => `${Math.round(x * 100)}%`;
  function renderManaSim() {
    const box = $('#manaSim');
    if (!window.ManaSim) { box.innerHTML = ''; return []; }
    const list = state.main.filter(e => e.card);
    // デッキに登録済みのコンボ（パーツとデッキ要件がそろっているもの）を一人回しでもそろったか見る
    const lands = state.main.filter(e => rolesOf(e).includes('land')).reduce((s, e) => s + e.qty, 0);
    const combos = window.Combos ? Combos.detect({ main: state.main }, lands).filter(x => x.complete).map(x => ({ name: x.combo.name, pieces: x.combo.pieces })) : [];
    const sig = list.map(e => `${e.qty}:${e.card.name}:${catOf(e)}`).sort().join('|') + '#' + combos.map(c => c.name).join('|');
    if (simCache.sig !== sig) {
      simCache = { sig, result: null, pending: true };
      box.innerHTML = list.length ? '<p class="hint">一人回し中…</p>' : '';
      setTimeout(() => {
        if (simCache.sig !== sig) return;
        let r = null;
        try { r = ManaSim.simulate(list.map(e => ({ qty: e.qty, card: e.card, cat: catOf(e) })), { combos }); } catch (err) { console.error(err); }
        if (r) r.comboNames = combos.map(c => c.name);
        simCache = { sig, result: r, pending: false };
        renderAnalysis();
      }, 30);
      return [];
    }
    const r = simCache.result;
    if (!r) { box.innerHTML = simCache.pending ? '<p class="hint">一人回し中…</p>' : ''; return []; }

    const tips = [];
    const TT = [3, 4, 5].filter(t => t <= r.turns);
    const n1 = x => x.toFixed(1);
    const pd = (p, d, f) => `${f(p)}<span class="muted">/${f(d)}</span>`;
    const B = (side, t) => r[side].board[t - 1];
    const brow = (label, f, fmt = n1) => `<tr><td>${label}</td>${TT.map(t => `<td>${pd(f('play', t), f('draw', t), fmt)}</td>`).join('')}</tr>`;
    const per = (side, t, k) => { const b = B(side, t); return b.creatures ? b[k] / b.creatures : 0; };
    let html = `<h3>3・4・5ターン目の盤面（先手/後手の平均。相手が何もしない場合）</h3>
      <div class="sim-scroll"><table class="meta-table sim-table board-table"><tr><th></th>${TT.map(t => `<th>${t}T</th>`).join('')}</tr>
      ${brow('クリーチャー（体）', (s, t) => B(s, t).creatures)}
      ${brow('合計パワー', (s, t) => B(s, t).power)}
      ${brow('合計タフネス', (s, t) => B(s, t).toughness)}
      <tr><td>1体あたり P/T（先手）</td>${TT.map(t => `<td>${n1(per('play', t, 'power'))}/${n1(per('play', t, 'toughness'))}</td>`).join('')}</tr>
      ${brow('タフネス1以下（体）', (s, t) => B(s, t).t1)}
      ${brow('タフネス2以下（体）', (s, t) => B(s, t).t2)}
      ${brow('タフネス3以下（体）', (s, t) => B(s, t).t3)}
      ${brow('3体以上並ぶ率', (s, t) => r[s].wide[t - 1], pctTxt)}
      ${brow('アーティファクト', (s, t) => B(s, t).artifact)}
      ${brow('エンチャント', (s, t) => B(s, t).enchantment)}
      ${brow('PW', (s, t) => B(s, t).planeswalker)}
      ${brow('出せるマナ', (s, t) => r[s].avg[t - 1])}
      ${r.hasDisrupt ? brow('妨害を構えられた', (s, t) => r[s].held[t - 1], pctTxt) : ''}
      ${r.comboNames && r.comboNames.length ? brow('コンボがそろった', (s, t) => r[s].combo[t - 1], pctTxt) : ''}
      </table></div>
      <p class="hint">トークンは出たとき・唱えたときに出るものと、毎ターン出すもの（1ターンに1回として近似）を含みます。全体除去を撃たれたときにどれだけ巻き込まれるかの目安にしてね。</p>`;
    if (TT.includes(4)) {
      const b = B('play', 4);
      tips.push({ level: 'info', text: `4ターン目の盤面（先手）は、クリーチャー平均${n1(b.creatures)}体（パワー計${n1(b.power)}）、タフネス2以下が${n1(b.t2)}体、3体以上並ぶ率${pctTxt(r.play.wide[3])}。アーティファクト${n1(b.artifact)}・エンチャント${n1(b.enchantment)}・PW${n1(b.planeswalker)}。` });
      if (r.comboNames && r.comboNames.length) tips.push({ level: 'info', text: `コンボ（${r.comboNames.join('、')}）のパーツが4ターン目までにそろった率は先手${pctTxt(r.play.combo[3])}・後手${pctTxt(r.draw.combo[3])}。` });
    }

    // ターンごとの動き
    const T6 = [...Array(r.turns).keys()];
    const row = (label, f) => `<tr><td>${label}</td>${T6.map(t => `<td>${f(t)}</td>`).join('')}</tr>`;
    html += `<h3>ターンごとの動き（先手）</h3>
      <div class="sim-scroll"><table class="meta-table sim-table"><tr><th></th>${T6.map(t => `<th>${t + 1}T</th>`).join('')}</tr>
      ${row('出せるマナ', t => r.play.avg[t].toFixed(1))}
      ${row('何もできない', t => pctTxt(r.play.idle[t]))}
      ${row('使い残し', t => r.play.unused[t].toFixed(1))}
      ${r.hasDisrupt ? row('妨害を手札に持つ', t => pctTxt(r.play.inHand[t])) : ''}
      ${r.hasDisrupt ? row('妨害を構えられた', t => pctTxt(r.play.held[t])) : ''}
      </table></div>`;
    [2, 3].forEach(t => {
      if (t <= r.turns && r.play.idle[t - 1] > 0.25) tips.push({ level: 'warn', text: `${t}ターン目に何も唱えられず、妨害も構えられなかった率が${pctTxt(r.play.idle[t - 1])}（先手）。${t}マナ以下で動けるカードを増やすと安定するよ。` });
    });
    if (r.turns >= 4 && r.play.unused[3] >= 1.5) tips.push({ level: 'info', text: `4ターン目に平均${r.play.unused[3].toFixed(1)}マナ余ってるよ。マナの使い道（重めのカードや起動型能力）を足す余地があるかも。` });
    if (r.hasDisrupt) {
      tips.push({ level: 'info', text: `妨害を手札に持っていた率は、2ターン目${pctTxt(r.play.inHand[1])}・3ターン目${pctTxt(r.play.inHand[2])}。そのうち構えるマナもあった率は${pctTxt(r.play.held[1])}・${pctTxt(r.play.held[2])}（先手、妨害以外の呪文を我慢した場合を含む）。` });
      if (r.play.inHand[2] < 0.5) tips.push({ level: 'warn', text: `3ターン目までに妨害を手札に持てていない率が${pctTxt(1 - r.play.inHand[2])}。相手の動きを止めたいなら、妨害の枚数か、引きにいくカードを見直してみて。` });
    } else tips.push({ level: 'info', text: '妨害（大カテゴリが【妨害】のカード）が入っていないよ。相手の動きに干渉しない、速さ勝負のデッキとして回した結果だよ。' });

    html += `<p class="hint">相手が何もしない前提で、マリガンなし・7枚キープで${r.iters.toLocaleString()}回一人回しした結果。妨害は唱えずに構えたものとして数え、効果を読み取れないカードは「唱えた」ことだけを記録しています。カードの使い方は簡単なルールで決めているので、上手な人が回すより少し低めに出ることがあるよ。</p>`;
    box.innerHTML = html;
    return tips;
  }

  // ---------- 上位デッキとの比較（benchmarks/ の集計データ） ----------
  const META_FORMATS = { standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy', vintage: 'Vintage', pauper: 'Pauper' };
  const metaStore = {}; // fmt -> { status: 'loading'|'ok'|'missing'|'error', bench, defs }

  async function loadMeta(fmt) {
    if (metaStore[fmt]) return;
    metaStore[fmt] = { status: 'loading' };
    try {
      const [b, d] = await Promise.all([fetch(`benchmarks/${fmt}.json`), fetch(`benchmarks/archetypes/${fmt}.json`)]);
      if (!b.ok || !d.ok) { metaStore[fmt] = { status: 'missing' }; }
      else metaStore[fmt] = { status: 'ok', bench: await b.json(), defs: await d.json() };
    } catch (e) {
      metaStore[fmt] = { status: 'error', message: e.message };
    }
    renderAnalysis();
    fillArchSelect();
  }

  function deckColors() {
    const set = new Set();
    state.main.forEach(e => {
      if (e.card && !rolesOf(e).includes('land')) (e.card.colors || []).forEach(c => set.add(c));
    });
    return set;
  }

  /** 比較対象のグループ（アーキタイプ or 全体）と、役割ごとの目安範囲を返す */
  function metaComparison() {
    const fmt = state.meta;
    if (!fmt) return null;
    const m = metaStore[fmt];
    if (!m) { loadMeta(fmt); return { status: 'loading' }; }
    if (m.status !== 'ok') return { status: m.status, message: m.message };
    const bench = m.bench;
    let detected = null, group = null, how = '';
    if (state.main.length) {
      detected = Archetype.classify({ main: state.main, side: state.side }, m.defs, deckColors());
    }
    if (state.metaArch === 'auto') {
      if (detected) group = bench.archetypes.find(a => a.name === detected.name);
      how = group ? '自動判定' : '自動判定できなかったのでフォーマット全体';
    } else if (state.metaArch !== 'all') {
      group = bench.archetypes.find(a => a.name === state.metaArch);
      how = '手動で選択';
    }
    if (!group) { group = { name: `${bench.format} 全体`, ...bench.overall, keyCards: null }; if (!how) how = 'フォーマット全体'; }
    const targets = {};
    for (const [k, s] of Object.entries(group.roles || {})) {
      if (Roles.ROLE_MAP[k]) targets[k] = [Math.floor(s.q1), Math.ceil(s.q3)];
    }
    for (const [k, s] of Object.entries(group.cats || {})) {
      if (Roles.CAT_MAP[k]) targets['cat:' + k] = [Math.floor(s.q1), Math.ceil(s.q3)];
    }
    return { status: 'ok', bench, detected, group, how, targets, label: group.name };
  }

  function fillArchSelect() {
    const sel = $('#metaArch');
    const m = state.meta && metaStore[state.meta];
    const archs = m && m.status === 'ok' ? m.bench.archetypes : [];
    sel.disabled = !state.meta;
    sel.innerHTML = `<option value="auto">アーキタイプ: 自動判定</option><option value="all">フォーマット全体</option>` +
      archs.map(a => `<option value="${esc(a.name)}">${esc(a.name)}（${a.n}${a.reference ? '・参考値' : ''}）</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === state.metaArch) ? state.metaArch : 'auto';
  }

  function renderMeta(cmp, a) {
    const box = $('#metaInfo');
    if (!cmp) { box.innerHTML = '<p class="hint">フォーマットを選ぶと、MTGOで勝っているデッキの役割の枚数と比べられるよ。</p>'; return; }
    if (cmp.status === 'loading') { box.innerHTML = '<p class="hint">集計データを読み込み中…</p>'; return; }
    if (cmp.status === 'missing') { box.innerHTML = '<p class="hint">まだ集計データがありません。GitHub の Actions タブで「Build benchmarks」を実行してね。</p>'; return; }
    if (cmp.status !== 'ok') { box.innerHTML = `<p class="hint">集計データを読み込めませんでした（${esc(cmp.message || '')}）</p>`; return; }
    const { bench, detected, group } = cmp;
    const det = detected ? `<div class="meta-detect">このデッキの判定：<b>${esc(detected.name)}</b>${detected.kind === 'fallback' ? '（近い構成から推定）' : ''}${detected.conflicts.length ? `<span class="muted">（他の候補: ${detected.conflicts.map(esc).join(', ')}）</span>` : ''}</div>` : '';
    // 大カテゴリ → その小カテゴリ の順に並べる
    const row = (key, label, v, s, cls) => {
      if (!s) return '';
      const t = cmp.targets[key];
      if (!t || (!v && !s.q3)) return '';
      const [lo, hi] = t;
      const st = v < lo - 1 ? 'low' : v > hi + 1 ? 'high' : (v < lo || v > hi) ? 'near' : 'ok';
      return `<tr class="${st} ${cls}"><td>${label}</td><td class="num">${v}</td><td class="num">${s.median}</td><td class="num muted">${s.q1}–${s.q3}</td></tr>`;
    };
    const rows = Roles.CATEGORIES.map(c =>
      row('cat:' + c.id, `<b>${c.label}</b>`, a.catCount[c.id] || 0, (group.cats || {})[c.id], 'cat') +
      Roles.ROLES.filter(r => r.cat === c.id && r.id !== 'other').map(r => row(r.id, r.label, a.roleCount[r.id] || 0, (group.roles || {})[r.id], 'sub')).join('')
    ).join('');
    const keys = group.keyCards ? `<details class="meta-keys"><summary>このアーキタイプでよく使われるカード（役割の判定確認用）</summary>
      <ul>${group.keyCards.map(c => `<li><span class="kc-name">${esc(c.name)}</span><span class="muted">${Math.round(c.rate * 100)}%・平均${c.avg}枚</span><span class="kc-roles">${c.cat && Roles.CAT_MAP[c.cat] ? `<span class="chip cat-chip" style="background:${Roles.CAT_MAP[c.cat].color}">${Roles.CAT_MAP[c.cat].label}</span>` : ''}${Roles.normalizeRoles(c.roles).map(r => `<span class="chip" style="background:${Roles.ROLE_MAP[r].color}">${Roles.ROLE_MAP[r].label}</span>`).join('')}</span></li>`).join('')}</ul></details>` : '';
    box.innerHTML = `${det}
      <div class="meta-group">比較対象：<b>${esc(group.name)}</b>（${esc(cmp.how)}）・${group.n} デッキ${group.reference ? '・<span class="warn-text">サンプル少なめの参考値</span>' : ''}</div>
      <table class="meta-table"><thead><tr><th>カテゴリ</th><th class="num">あなた</th><th class="num">中央値</th><th class="num">中央50%</th></tr></thead><tbody>${rows}</tbody></table>
      ${keys}
      <p class="hint">${esc(bench.window.from)}〜${esc(bench.window.to)} の MTGO 公開デッキリスト（Challenge上位・リーグ5-0、${bench.events} 大会）を集計。
      出典: <a href="https://github.com/fbettega/MTG_decklistcache" target="_blank" rel="noopener">MTG_decklistcache</a> /
      アーキタイプ定義: <a href="https://github.com/Badaro/MTGOFormatData" target="_blank" rel="noopener">MTGOFormatData</a>（MIT）</p>`;
  }

  // ---------- 効果タグ ----------
  function tagListHTML(card) {
    if (!card) return '';
    const info = Roles.inspect(card);
    const backHTML = info.back && (info.back.tags.length || info.back.allRoles.length)
      ? `<div class="muted" style="margin-top:6px">変身後（手札からは唱えられない面。役割の枚数やカテゴリには数えないよ）</div>
        <div class="muted">役割: ${info.back.allRoles.map(r => esc((Roles.ROLE_MAP[r] || {}).label || r)).join('・') || 'なし'}</div>
        ${info.back.tags.map(t => `<div class="tag back ${t.repeat ? 'rep' : 'once'}"><span class="tag-kind">${t.repeat ? '繰り返し' : '1回'}</span><span>${esc(Tags.tagLabel(t))}</span></div>`).join('')}`
      : '';
    const ultHTML = info.ult
      ? `<div class="muted" style="margin-top:6px">奥義（出たターンには起動できない忠誠度能力。役割の枚数やカテゴリには数えないよ）</div>
        <div class="muted">役割: ${info.ult.allRoles.map(r => esc((Roles.ROLE_MAP[r] || {}).label || r)).join('・') || 'なし'}</div>
        ${info.ult.tags.map(t => `<div class="tag back once"><span class="tag-kind">奥義</span><span>${esc(Tags.EFFECT_MAP[t.effect].label)}</span></div>`).join('')}`
      : '';
    if (!info.tags.length) return `<div class="tag-list"><div class="muted">検出した効果タグはありません</div>${backHTML}${ultHTML}</div>`;
    const L = Roles.DISRUPT_LABELS;
    const detail = t => {
      if (!t.detail) return '';
      const d = t.detail;
      const parts = [L.action[d.action] || d.action, d.types.map(x => L.types[x] || x).join('・'), L.targeting[d.targeting],
        d.scope === 'all' ? '全体' : d.scope === 'multi' ? '複数' : '', d.cond ? `条件: ${d.cond}` : '',
        d.gives ? `相手に${d.gives === 'token' ? 'トークン' : d.gives === 'land' ? '土地' : 'ライフ'}` : '', L.speed[t.speed] || ''];
      return `<div class="tag-detail">${parts.filter(Boolean).map(esc).join(' ／ ')}</div>`;
    };
    const TOKEN_JA = { creature: 'クリーチャー', treasure: '宝物', clue: '手掛かり', food: '食物', blood: '血', map: '地図', powerstone: 'パワーストーン', incubator: 'インキュベーター', role: '役割', copy: 'コピー', other: 'その他' };
    const tokens = info.tokens.length ? `<div class="muted" style="margin-top:4px">生成するトークン</div>${info.tokens.map(k =>
      `<div class="tag ${k.who === 'opponent' ? 'once' : 'rep'}"><span class="tag-kind">${k.who === 'opponent' ? '相手' : '自分'}</span>${esc(TOKEN_JA[k.kind] || k.kind)}${k.pt ? ` ${esc(k.pt)}` : ''}</div>`).join('')}` : '';
    return `<div class="tag-list"><div class="muted">検出した効果タグ（${info.speed === 'instant' ? 'インスタント速度で動ける' : 'ソーサリー速度'}）</div>${info.tags.map(t =>
      `<div class="tag ${t.repeat ? 'rep' : 'once'}"><span class="tag-kind">${t.repeat ? '繰り返し' : '1回'}</span><span>${esc(Tags.tagLabel(t))}${detail(t)}</span></div>`).join('')}${tokens}${backHTML}${ultHTML}</div>`;
  }

  // ---------- 上位デッキへの対策（フェアデッキを含む） ----------
  // 山札 N 枚から n 枚見て、K 枚ある対処札を1枚以上引く確率
  function atLeastOne(N, K, n) {
    if (K <= 0) return 0;
    let p = 1;
    for (let i = 0; i < n; i++) p *= Math.max(0, N - K - i) / (N - i);
    return 1 - p;
  }
  function renderMatchups(cmp) {
    const tips = [];
    const box = $('#matchBox');
    const meta = cmp && cmp.bench && cmp.bench.meta;
    if (!meta) { box.innerHTML = '<p class="hint">上の「上位デッキとの比較」でフォーマットを選ぶと、環境の上位デッキ（シェア3%以上）への対策を表示します。</p>'; return tips; }
    if (!meta.some(m => m.threats)) { box.innerHTML = '<p class="hint">ベンチマークのデータが古い形式なので、次回の集計後に表示されます。</p>'; return tips; }
    const mainE = state.main.filter(e => e.card), sideE = state.side.filter(e => e.card);
    if (!mainE.length) { box.innerHTML = ''; return tips; }
    const deckN = mainE.reduce((s, e) => s + e.qty, 0);
    const sim = simCache.result;
    const myArch = cmp.group && cmp.group.name;
    const pct = x => `${Math.round(x * 100)}%`;
    const short = list => list.length > 3 ? list.slice(0, 3).join('、') + ' など' : list.join('、');

    const rows = meta.filter(m => m.share >= 0.03 && m.name !== myArch).sort((a, b) => b.share - a.share);
    const html = rows.map(m => {
      const threats = (m.threats || []).slice(0, 4);
      const ans = (list, t) => list.filter(e => Roles.answerOf(e.card, t));
      const cells = threats.map(t => {
        const a = ans(mainE, t).reduce((s, e) => s + e.qty, 0), b = ans(sideE, t).reduce((s, e) => s + e.qty, 0);
        return { t, main: a, side: b };
      });
      // 主力（勝ち手段・コンボ）の脅威に対処できるメインのカード
      const keyThreats = threats.filter(t => t.cat !== 'resource');
      const focus = keyThreats.length ? keyThreats : threats;
      const answerCards = mainE.filter(e => focus.some(t => Roles.answerOf(e.card, t)));
      const K = answerCards.reduce((s, e) => s + e.qty, 0);
      const kt = m.sim && m.sim.keyTurn;
      let chance = null;
      if (kt && K) {
        const seen = 7 + (kt - 1); // 先手
        const minCmc = Math.min(...answerCards.map(e => Math.round(e.card.cmc || 0)));
        const manaOk = sim ? (sim.play.ge[Math.min(kt, sim.turns) - 1][Math.min(minCmc, 11)] || 0) : 1;
        chance = atLeastOne(deckN, K, seen) * manaOk;
      }
      // 腐りやすいメインの妨害と、サイドの入れ替え先
      const dead = mainE.filter(e => Roles.inspect(e.card).cat === 'disrupt' && Roles.deadAgainst(e.card, m));
      const deadN = dead.reduce((s, e) => s + e.qty, 0);
      const good = sideE.filter(e => !Roles.deadAgainst(e.card, m) && (threats.some(t => Roles.answerOf(e.card, t)) || (m.graveyard && Roles.inspect(e.card).roles.includes('gyhate'))));

      const noAns = cells.filter(c => c.t.rate >= 0.8 && c.t.cat !== 'resource' && !c.main && !c.side).map(c => c.t.name);
      if (noAns.length) tips.push({ level: 'bad', text: `環境の${pct(m.share)}の${m.name}の主力（${short(noAns)}）に対処できるカードが、メインにもサイドにもないよ。` });
      if (chance != null && chance < 0.4 && m.share >= 0.05) tips.push({ level: 'warn', text: `対${m.name}（${pct(m.share)}）: 相手のキーターン（${kt}ターン目）までに対処札を手札に持って唱えられる率が${pct(chance)}（先手）。` });
      if (deadN >= 2) {
        if (good.length) tips.push({ level: 'info', text: `対${m.name}（${pct(m.share)}）では、メインの${short(dead.map(e => displayName(e.card)))}（計${deadN}枚）が腐りやすいよ。サイドの${short(good.map(e => displayName(e.card)))}と入れ替える候補だね。` });
        else tips.push({ level: 'info', text: `対${m.name}（${pct(m.share)}）では、メインの${short(dead.map(e => displayName(e.card)))}（計${deadN}枚）が腐りやすいよ。サイドに入れ替え先になるカードが見当たらないかも。` });
      }

      const cls = c => (c.main + c.side) === 0 ? 'c-low' : c.main === 0 ? 'c-near' : 'c-ok';
      // 開いたときの中身: 対処札の一覧、脅威ごとの対処札、惜しくも数えなかったカード、入れ替え候補
      const HOW = { removal: '除去', counter: '打ち消し', discard: '手札破壊' };
      const listOf = list => {
        const rows = list.map(e => {
          const hows = [...new Set(threats.map(t => Roles.answerOf(e.card, t)).filter(Boolean).map(x => HOW[x.how]))];
          return hows.length ? `${esc(displayName(e.card))}×${e.qty}<span class="muted">（${hows.join('・')}）</span>` : '';
        }).filter(Boolean);
        return rows.length ? rows.join('、') : '<span class="muted">なし</span>';
      };
      const perThreat = threats.map(t => {
        const names = l => l.filter(e => Roles.answerOf(e.card, t)).map(e => esc(displayName(e.card)));
        const mn = names(mainE), sd = names(sideE);
        const info = [t.type ? esc(t.type.replace(/^Legendary /, '')) : '', t.toughness ? `タフネス${esc(t.toughness)}` : '', t.mv != null ? `MV${t.mv}` : ''].filter(Boolean).join('・');
        return `<li><b>${esc(t.name)}</b> <span class="muted">${info}／採用率${pct(t.rate)}</span><br>
          メイン: ${mn.length ? mn.join('、') : '<span class="bad-t">なし</span>'}${sd.length ? `　<span class="muted">サイド: ${sd.join('、')}</span>` : ''}</li>`;
      }).join('');
      // 対処系の能力はあるが、ダメージ量やマナ総量の条件で当たらなかったカード
      const near = [];
      [...mainE, ...sideE].forEach(e => threats.forEach(t => {
        const w = Roles.answerWhy(e.card, t);
        if (w && !w.ok && w.reason !== 'type') near.push(`${esc(displayName(e.card))} → ${esc(t.name)}（${esc(w.note)}）`);
      }));
      const body = `<div class="mu-body">
          <div><b>対処札（メイン）</b>: ${listOf(mainE)}</div>
          <div><b>対処札（サイド）</b>: ${listOf(sideE)}</div>
          <div class="mu-sub">脅威ごと</div><ul class="mu-list">${perThreat}</ul>
          ${near.length ? `<div class="mu-sub">数えなかったカード</div><ul class="mu-list">${[...new Set(near)].map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
          ${deadN ? `<div class="mu-sub">腐りやすい枠</div><div>${esc(dead.map(e => `${displayName(e.card)}×${e.qty}`).join('、'))}${good.length ? `<br>→ 入れ替え候補（サイド）: ${esc(good.map(e => `${displayName(e.card)}×${e.qty}`).join('、'))}` : '<br><span class="muted">サイドに入れ替え先が見当たらない</span>'}</div>` : ''}
        </div>`;
      return `<details class="mu" data-arch="${esc(m.name)}" ${openArch.has(m.name) ? 'open' : ''}><summary>
        <div class="mu-head"><b>${esc(m.name)}</b> <span class="num">${pct(m.share)}</span>${kt ? ` <span class="muted">キーターン ${kt}T</span>` : ''}<span class="mu-toggle muted"></span></div>
        <div class="mu-threats">${cells.map(c => `<span class="mu-t ${cls(c)}" title="採用率${pct(c.t.rate)}・平均${c.t.avg}枚">${esc(c.t.name)} <b>${c.main}</b><span class="muted">/${c.side}</span></span>`).join('')}</div>
        ${chance != null ? `<div class="muted">キーターンまでに対処札を持って唱えられる率（先手）: <b>${pct(chance)}</b>（対処札 ${K} 枚）</div>` : ''}
        ${deadN ? `<div class="muted">腐りやすい枠あり（${deadN}枚）</div>` : ''}
      </summary>${body}</details>`;
    }).join('');
    box.innerHTML = (html || '<p class="hint">シェア3%以上の上位デッキがありません</p>') +
      `<p class="hint">脅威＝そのアーキタイプの40%以上が採用する勝ち手段・コンボ/展開のカードと、居座って働くクリーチャー・プレインズウォーカー・エンジン。押すと対処札の一覧を開けます。数字はメイン/サイドの対処札の枚数（除去・打ち消し・手札破壊。ダメージ量とタフネス、「マナ総量N以下」の条件も見ています）。キーターン＝代表リストを一人回しして主力が50%以上出ているターン。腐りやすい枠＝相手のパーマネント構成に対象がほとんどない妨害。</p>`;
    box.querySelectorAll('details.mu').forEach(d => d.addEventListener('toggle', () => {
      if (d.open) openArch.add(d.dataset.arch); else openArch.delete(d.dataset.arch);
    }));
    return tips;
  }

  // ---------- コンボ ----------
  /** 自分のデッキのコンボと、環境のコンボに対する備えを表示し、アドバイスを返す */
  function renderCombos(cmp) {
    const tips = [];
    const box = $('#comboBox');
    const lands = state.main.filter(e => rolesOf(e).includes('land')).reduce((s, e) => s + e.qty, 0);
    const mine = Combos.detect({ main: state.main }, lands);
    const mineHTML = mine.length ? mine.map(x => {
      const c = x.combo;
      const status = x.complete ? '<span class="combo-ok">成立</span>'
        : x.missing.length ? `<span class="combo-miss">パーツ不足：${x.missing.map(g => esc(g.join(' か '))).join('、')}</span>`
        : `<span class="combo-miss">条件未達：${x.reqFail.map(esc).join('、')}</span>`;
      return `<li><b>${esc(c.name)}</b> <span class="muted">${esc(Combos.KIND_JA[c.kind] || c.kind)}</span> ${status}${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}</li>`;
    }).join('') : '';

    // 環境のコンボ（アーキタイプの割合 × そのアーキタイプでの採用率）
    let metaHTML = '';
    const meta = cmp && cmp.bench && cmp.bench.meta;
    if (meta) {
      const share = {};
      meta.forEach(a => (a.combos || []).forEach(x => { share[x.id] = (share[x.id] || 0) + a.share * x.rate; }));
      const entries = [...state.main.map(e => ({ ...e, zone: 'メイン' })), ...state.side.map(e => ({ ...e, zone: 'サイド' }))];
      const rows = Combos.list().filter(c => (share[c.id] || 0) >= 0.02).sort((a, b) => share[b.id] - share[a.id]).map(c => {
        const ans = Combos.answerCards(entries, c);
        const n = ans.reduce((s, x) => s + x.qty, 0);
        const pct = Math.round(share[c.id] * 100);
        const how = (c.answers || []).map(a => Combos.answerLabel(a)).join('・');
        if (state.main.length) {
          if (!n) tips.push({ level: 'bad', text: `環境の${pct}%に「${c.name}」（${Combos.KIND_JA[c.kind] || c.kind}）がいるのに、止められるカードがメインにもサイドにも無いよ。効くのは：${how}。` });
          else if (n <= 2) tips.push({ level: 'warn', text: `環境の${pct}%に「${c.name}」。止められるカードは${n}枚（${ans.map(x => x.name).join('、')}）だけ。効くのは：${how}。` });
        }
        return `<tr class="${!n ? 'c-low' : n <= 2 ? 'c-near' : 'c-ok'}"><td>${esc(c.name)}<div class="muted">${esc(how)}</div></td><td class="num">${pct}%</td><td class="num">${n}</td></tr>`;
      }).join('');
      metaHTML = rows ? `<table class="meta-table"><thead><tr><th>環境のコンボ（止め方）</th><th class="num">環境</th><th class="num">止める札</th></tr></thead><tbody>${rows}</tbody></table>` : '';
    }
    box.innerHTML = (mineHTML ? `<ul class="combo-list">${mineHTML}</ul>` : '<p class="hint">登録済みのコンボはデッキにありません</p>') + metaHTML +
      '<p class="hint">コンボの定義は data/combos.json。「止める札」はメイン＋サイドで、そのコンボに効く妨害の枚数です。</p>';
    return tips;
  }

  /** 妨害の内訳（処理・対象の種類・選び方・速度）。サイドボードと上位デッキの中央値も並べる */
  function renderDisrupt(main, side, group) {
    const L = Roles.DISRUPT_LABELS;
    const bd = group && group.disrupt;
    const sections = [['form', '形態'], ['action', '処理・移動先'], ['types', '触れられる対象'], ['targeting', '選び方'], ['speed', '速度']];
    const rows = sections.map(([key, title]) => {
      const keys = [...new Set([...Object.keys(main[key] || {}), ...Object.keys(side[key] || {}), ...Object.keys(bd || {}).filter(k => k.startsWith(key + ':')).map(k => k.slice(key.length + 1))])]
        .filter(k => k !== 'trigger' && k !== 'static' && k !== 'player')
        .filter(k => ((main[key] || {})[k] || 0) || ((side[key] || {})[k] || 0) || (bd && bd[`${key}:${k}`] && bd[`${key}:${k}`].median));
      if (!keys.length) return '';
      return `<tr class="cat"><td colspan="4"><b>${title}</b></td></tr>` + keys.map(k => {
        const b = bd && bd[`${key}:${k}`];
        return `<tr class="sub"><td>${esc(L[key][k] || k)}</td><td class="num">${(main[key] || {})[k] || 0}</td><td class="num muted">${(side[key] || {})[k] || 0}</td><td class="num muted">${b ? b.median : '–'}</td></tr>`;
      }).join('');
    }).join('');
    $('#disruptTable').innerHTML = main.total || side.total
      ? `<table class="meta-table"><thead><tr><th>妨害カード ${main.total}枚</th><th class="num">メイン</th><th class="num">サイド</th><th class="num">上位中央値</th></tr></thead><tbody>${rows}</tbody></table>
         <p class="hint">妨害カードの枚数を性質ごとに数えたもの（1枚が複数に入ることがあります）。「追放」かどうか、アーティファクトやエンチャントに触れられるか、相手のターンに使えるかが見られます。</p>`
      : '<p class="hint">妨害カードがまだありません</p>';
  }

  /** デッキ全体の効果タグを「繰り返し／1回」で集計して表示（上位デッキの中央値があれば並べる） */
  function renderTags(a, group) {
    const root = $('#tagTable');
    const benchTags = group && group.tags;
    const rows = Tags.EFFECTS.map(e => {
      const r = a.tagCounts[e.id + ':r'] || 0, o = a.tagCounts[e.id + ':o'] || 0;
      const br = benchTags && benchTags[e.id + ':r'], bo = benchTags && benchTags[e.id + ':o'];
      if (!r && !o && !(br && br.q3) && !(bo && bo.q3)) return '';
      const cell = (v, b) => `<td class="num">${v}${b ? ` <span class="muted">/ ${b.median}</span>` : ''}</td>`;
      return `<tr><td>${esc(e.label)}</td>${cell(r, br)}${cell(o, bo)}</tr>`;
    }).join('');
    root.innerHTML = rows
      ? `<table class="meta-table"><thead><tr><th>効果</th><th class="num">繰り返し</th><th class="num">1回</th></tr></thead><tbody>${rows}</tbody></table>
         <p class="hint">その効果を持つカードの枚数。${benchTags ? '「/」の右は上位デッキの中央値。' : ''}カードの役割チップを押すと、カードごとのタグ（効果 × 発動条件）を確認できます。</p>`
      : '<p class="hint">効果タグのあるカードがまだありません</p>';
  }

  function renderSaved() {
    const saved = savedDecks();
    const names = Object.keys(saved).sort();
    $('#savedList').innerHTML = names.length
      ? names.map(n => `<div class="saved-row"><button data-load="${esc(n)}">${esc(n)}</button><button class="del" data-del="${esc(n)}" title="削除">✕</button></div>`).join('')
      : '<div class="hint" style="padding:4px 10px">まだありません</div>';
  }

  // ---------- 役割エディタ ----------
  function openRoleEditor(zone, name, anchor) {
    const e = state[zone].find(x => x.name === name);
    if (!e) return;
    const pop = $('#rolePop');
    const info = Roles.inspect(e.card);
    const auto = info.roles;
    const draw = () => {
      const current = new Set(rolesOf(e));
      const autoCat = (e.manualRoles && e.manualRoles.length) ? Roles.categoryOf(Roles.normalizeRoles(e.manualRoles)) : info.cat;
      pop.innerHTML = `<h4>${esc(e.card ? displayName(e.card) : e.name)}</h4>
        <label class="pop-cat">主な採用理由
          <select data-pop="cat">
            <option value="">自動（${esc(Roles.CAT_MAP[autoCat].label)}）</option>
            ${Roles.CATEGORIES.map(c => `<option value="${c.id}" ${e.manualCat === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </label>
        ${info.override ? `<div class="muted pop-note">例外リストで指定${info.override.note ? `：${esc(info.override.note)}` : ''}</div>` : ''}
        ${Roles.CATEGORIES.filter(c => c.id !== 'other').map(c => `<div class="pop-group"><div class="pop-group-head" style="color:${c.color}">${c.label}</div>
          ${Roles.ROLES.filter(r => r.cat === c.id).map(r => `<label><input type="checkbox" value="${r.id}" ${current.has(r.id) ? 'checked' : ''}>
            <span class="sw" style="background:${r.color}"></span>${r.label}${auto.includes(r.id) ? ' <span class="muted">自動</span>' : ''}</label>`).join('')}</div>`).join('')}
        ${tagListHTML(e.card)}
        <div class="pop-actions"><button data-pop="reset">自動判定に戻す</button><button data-pop="close" class="primary">OK</button></div>`;
    };
    draw();
    const rect = anchor.getBoundingClientRect();
    pop.hidden = false;
    const top = Math.min(window.innerHeight - pop.offsetHeight - 8, rect.bottom + 4);
    const left = Math.min(window.innerWidth - pop.offsetWidth - 8, rect.left);
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.max(8, left) + 'px';

    pop.onchange = ev => {
      if (ev.target.dataset.pop === 'cat') {
        e.manualCat = ev.target.value || null;
      } else {
        const checked = [...pop.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
        const same = checked.length === auto.length && checked.every(r => auto.includes(r));
        e.manualRoles = same || !checked.length ? null : Roles.PRIORITY.filter(r => checked.includes(r));
      }
      render();
      draw();
    };
    pop.onclick = ev => {
      const act = ev.target.dataset.pop;
      if (act === 'reset') { e.manualRoles = null; e.manualCat = null; render(); pop.hidden = true; }
      if (act === 'close') pop.hidden = true;
    };
  }

  // ---------- 検索 ----------
  let acTimer = null, acSeq = 0, acIndex = -1;
  async function doSearch(q) {
    q = q.trim();
    if (!q) return;
    $('#autocomplete').innerHTML = '';
    setStatus(`「${q}」を検索中…`);
    const res = $('#searchResults');
    try {
      const cards = await Scryfall.search(q, 60);
      if (!cards.length) res.innerHTML = '<div class="empty">見つかりませんでした</div>';
      else res.innerHTML = cards.map((c, i) => `<div class="result" data-i="${i}" title="${esc(c.name)}${c.printedName ? ' / ' + esc(c.printedName) : ''}">
          ${c.imgSmall ? `<img src="${c.imgSmall}" alt="${esc(c.name)}" loading="lazy">` : `<div class="noimg">${esc(c.name)}</div>`}
          <div class="r-name">${esc(displayName(c))}</div>
          <div class="r-add"><button data-add="main" title="メインに追加">メイン</button><button data-add="side" title="サイドに追加">サイド</button></div>
        </div>`).join('');
      res._cards = cards;
      setStatus(`${cards.length} 件ヒット`);
    } catch (err) {
      res.innerHTML = `<div class="empty">エラー: ${esc(err.message)}</div>`;
      setStatus('検索エラー');
    }
  }

  function scheduleAutocomplete(text) {
    clearTimeout(acTimer);
    // 日本語や構文入力では補完しない
    if (text.length < 3 || /[぀-ヿ一-龯:<>=]/.test(text)) { $('#autocomplete').innerHTML = ''; return; }
    acTimer = setTimeout(async () => {
      const seq = ++acSeq;
      const list = await Scryfall.autocomplete(text).catch(() => []);
      if (seq !== acSeq) return;
      acIndex = -1;
      $('#autocomplete').innerHTML = list.slice(0, 12).map(n => `<li data-name="${esc(n)}">${esc(n)}</li>`).join('');
    }, 350); // 入力中は叩かない（デバウンス）
  }

  async function addByName(name, zone) {
    $('#autocomplete').innerHTML = '';
    const card = await Scryfall.fetchNamed(name, false);
    if (card) addCard(card, zone); else toast(`${name} が見つかりませんでした`);
  }

  // ---------- UIユーティリティ ----------
  function setStatus(t) { $('#status').textContent = t; }
  let flashTimer;
  function flashStatus(t) { setStatus(t); clearTimeout(flashTimer); flashTimer = setTimeout(() => setStatus('準備OK'), 2000); }
  let toastTimer;
  function toast(t) {
    const el = $('#toast');
    el.textContent = t; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }

  function showPreview(card, x, y) {
    if (!card || !card.img) return;
    const pv = $('#preview');
    const img = pv.querySelector('img');
    if (img.src !== card.img) img.src = card.img;
    pv.hidden = false;
    const w = 250, h = 350;
    pv.style.left = (x + 20 + w > window.innerWidth ? x - w - 20 : x + 20) + 'px';
    pv.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y - h / 2)) + 'px';
  }
  function hidePreview() { $('#preview').hidden = true; }

  // ---------- スマホ向け ----------
  const touchQuery = window.matchMedia('(hover: none)');
  const isTouch = () => touchQuery.matches;

  let zoomCard = null;
  function openZoom(card, allowAdd) {
    if (!card) return;
    zoomCard = card;
    const z = $('#zoom');
    z.querySelector('img').src = card.img || card.imgSmall || '';
    z.querySelector('img').alt = card.name;
    z.querySelectorAll('[data-zoom="main"],[data-zoom="side"]').forEach(b => { b.hidden = !allowAdd; });
    z.hidden = false;
  }
  function closeZoom() { $('#zoom').hidden = true; zoomCard = null; }

  function showTab(panelClass) {
    document.querySelectorAll('.layout > .panel').forEach(p => p.classList.toggle('active', p.classList.contains(panelClass)));
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === panelClass));
    window.scrollTo({ top: 0 });
  }

  function findEntry(zone, name) { return state[zone].find(x => x.name === name); }

  // ---------- イベント ----------
  function bind() {
    // セレクト初期化
    $('#format').innerHTML = Object.entries(Roles.FORMATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    $('#archetype').innerHTML = Object.entries(Roles.ARCHETYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    $('#format').onchange = e => { state.format = e.target.value; render(); };
    $('#archetype').onchange = e => { state.archetype = e.target.value; render(); };
    $('#metaFormat').innerHTML = '<option value="">比較なし</option>' + Object.entries(META_FORMATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    $('#metaFormat').onchange = e => { state.meta = e.target.value; state.metaArch = 'auto'; fillArchSelect(); render(); };
    $('#metaArch').onchange = e => { state.metaArch = e.target.value; render(); };
    $('#deckName').oninput = e => { state.name = e.target.value; saveCurrent(); };

    // メニュー
    document.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-menu]');
      document.querySelectorAll('.menu-pop.open').forEach(m => { if (!btn || m.id !== btn.dataset.menu) m.classList.remove('open'); });
      if (btn) { const m = document.getElementById(btn.dataset.menu); m.classList.toggle('open'); if (m.id === 'saveMenu') renderSaved(); }
      else if (!ev.target.closest('.menu-pop')) { /* 外側クリックで閉じる */ }
      if (!ev.target.closest('#rolePop') && !ev.target.closest('[data-act="roles"]')) $('#rolePop').hidden = true;
    });
    const closeMenus = () => document.querySelectorAll('.menu-pop.open').forEach(m => m.classList.remove('open'));

    $('#btnNew').onclick = () => {
      if ((state.main.length || state.side.length) && !confirm('現在のデッキを破棄して新規作成しますか？')) return;
      state = blankDeck(); render();
    };
    $('#btnImportFile').onclick = () => { closeMenus(); $('#fileInput').click(); };
    $('#fileInput').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      importDeck(text, f.name, false);
      e.target.value = '';
    };
    $('#btnImportPaste').onclick = () => { closeMenus(); $('#pasteText').value = ''; $('#pasteDialog').showModal(); };
    $('#pasteDialog').addEventListener('close', () => {
      if ($('#pasteDialog').returnValue === 'ok') importDeck($('#pasteText').value, '', $('#pasteAppend').checked);
    });
    // ドラッグ&ドロップでもインポート
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', async e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) importDeck(await f.text(), f.name, false);
    });

    $('#btnExportTxt').onclick = () => {
      closeMenus();
      download(safeFileName() + '.txt', DeckIO.toText(exportEntries('main'), exportEntries('side')), 'text/plain;charset=utf-8');
    };
    $('#btnExportDek').onclick = () => {
      closeMenus();
      const noId = [...state.main, ...state.side].filter(e => !(e.card && e.card.mtgoId)).length;
      download(safeFileName() + '.dek', DeckIO.toDek(exportEntries('main'), exportEntries('side')), 'application/xml;charset=utf-8');
      if (noId) toast(`${noId} 種類は MTGO の CatID が取れなかったので 0 で出力しました（MTGOは名前で照合します）`);
    };
    $('#btnCopyTxt').onclick = async () => {
      closeMenus();
      const txt = DeckIO.toText(exportEntries('main'), exportEntries('side'));
      try { await navigator.clipboard.writeText(txt); toast('MTGO形式でコピーしました'); }
      catch (e) { $('#pasteText').value = txt; $('#pasteDialog').showModal(); }
    };

    $('#btnSave').onclick = () => {
      const name = (state.name || '').trim() || prompt('デッキ名を入力してください', '新しいデッキ');
      if (!name) return;
      state.name = name;
      const saved = savedDecks();
      saved[name] = serialize(state);
      localStorage.setItem(STORE_SAVED, JSON.stringify(saved));
      renderSaved(); render();
      toast(`「${name}」を保存しました`);
    };
    $('#savedList').onclick = ev => {
      const saved = savedDecks();
      const load = ev.target.dataset.load, del = ev.target.dataset.del;
      if (load && saved[load]) {
        const d = saved[load];
        state = { ...d, main: d.main.map(e => ({ ...e, card: null })), side: d.side.map(e => ({ ...e, card: null })) };
        closeMenus(); render(); resolveCards();
      }
      if (del && confirm(`「${del}」を削除しますか？`)) {
        delete saved[del];
        localStorage.setItem(STORE_SAVED, JSON.stringify(saved));
        renderSaved();
      }
    };

    // グループ切替
    document.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      groupMode = b.dataset.group; render();
    });

    // デッキ行の操作
    const onList = ev => {
      const row = ev.target.closest('.row');
      if (!row) return;
      const zone = row.dataset.zone, name = row.dataset.name;
      const actEl = ev.target.closest('[data-act]');
      const act = actEl && actEl.dataset.act;
      if (act === 'inc') changeQty(zone, name, 1);
      else if (act === 'dec') changeQty(zone, name, -1);
      else if (act === 'move') moveZone(zone, name);
      else if (act === 'roles') openRoleEditor(zone, name, actEl);
      else if (ev.target.closest('[data-preview]') && isTouch()) {
        const e = findEntry(zone, name);
        if (e && e.card) openZoom(e.card, false);
      }
    };
    $('#deckList').onclick = onList;
    $('#sideList').onclick = onList;
    for (const id of ['#deckList', '#sideList']) {
      $(id).addEventListener('mousemove', ev => {
        const n = ev.target.closest('[data-preview]');
        if (!n) return hidePreview();
        const row = n.closest('.row');
        const e = findEntry(row.dataset.zone, row.dataset.name);
        showPreview(e && e.card, ev.clientX, ev.clientY);
      });
      $(id).addEventListener('mouseleave', hidePreview);
    }

    // 検索
    const input = $('#searchInput');
    input.addEventListener('input', () => scheduleAutocomplete(input.value));
    input.addEventListener('keydown', ev => {
      const items = [...$('#autocomplete').querySelectorAll('li')];
      if (ev.key === 'ArrowDown' && items.length) { acIndex = (acIndex + 1) % items.length; ev.preventDefault(); }
      else if (ev.key === 'ArrowUp' && items.length) { acIndex = (acIndex - 1 + items.length) % items.length; ev.preventDefault(); }
      else if (ev.key === 'Escape') { $('#autocomplete').innerHTML = ''; return; }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (acIndex >= 0 && items[acIndex]) addByName(items[acIndex].dataset.name, ev.shiftKey ? 'side' : 'main');
        else { clearTimeout(acTimer); acSeq++; doSearch(input.value); }
        return;
      }
      items.forEach((li, i) => li.classList.toggle('active', i === acIndex));
    });
    $('#autocomplete').onclick = ev => {
      const li = ev.target.closest('li');
      if (li) addByName(li.dataset.name, 'main');
    };
    const results = $('#searchResults');
    results.onclick = ev => {
      const r = ev.target.closest('.result');
      if (!r) return;
      const card = results._cards[+r.dataset.i];
      const add = ev.target.closest('[data-add]');
      if (add) addCard(card, add.dataset.add);
      else if (isTouch()) openZoom(card, true);   // スマホ: タップで拡大
      else addCard(card, 'main');
    };
    results.oncontextmenu = ev => {
      const r = ev.target.closest('.result');
      if (!r) return;
      ev.preventDefault();
      addCard(results._cards[+r.dataset.i], 'side');
    };
    results.addEventListener('mousemove', ev => {
      const r = ev.target.closest('.result');
      if (!r) return hidePreview();
      showPreview(results._cards[+r.dataset.i], ev.clientX, ev.clientY);
    });
    results.addEventListener('mouseleave', hidePreview);

    $('#btnSearch').onclick = () => { clearTimeout(acTimer); acSeq++; input.blur(); doSearch(input.value); };
    $('#btnNewMobile').onclick = () => { closeMenus(); $('#btnNew').onclick(); };

    // タブバー（スマホ幅のみ表示）
    document.querySelector('.tabbar').onclick = ev => {
      const b = ev.target.closest('[data-tab]');
      if (b) showTab(b.dataset.tab);
    };
    showTab('deck-panel');

    // 拡大表示
    $('#zoom').onclick = ev => {
      const act = ev.target.dataset.zoom;
      if (act === 'main' || act === 'side') { if (zoomCard) addCard(zoomCard, act); closeZoom(); }
      else if (act === 'close' || ev.target === $('#zoom')) closeZoom();
    };
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeZoom(); });

    // API統計
    Scryfall.onStats(s => {
      $('#apiStats').textContent = `API送信 ${s.sent} ／ キャッシュ利用 ${s.cacheHits}${s.pending ? ` ／ 待機 ${s.pending}` : ''}`;
    });
    $('#btnClearCache').onclick = () => {
      if (confirm('Scryfall のカードキャッシュを削除しますか？（デッキは消えません）')) { Scryfall.clearCache(); toast('キャッシュを削除しました'); }
    };
  }

  // 例外リスト（カード名で採用理由を指定）とコンボの定義を読み込む
  async function loadOverrides() {
    try {
      const [o, c] = await Promise.all([fetch('data/overrides.json'), fetch('data/combos.json')]);
      if (o.ok) Roles.setOverrides(await o.json());
      if (c.ok) Combos.setCombos(await c.json());
      render();
    } catch (e) { /* file:// で開いた場合などは自動判定だけで動く */ }
  }

  bind();
  render();
  loadOverrides();
  resolveCards();
})();
