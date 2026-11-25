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
    return { name: '', format: 'constructed', archetype: 'midrange', main: [], side: [] };
  }

  function rolesOf(e) {
    if (e.manualRoles && e.manualRoles.length) return e.manualRoles;
    return Roles.classify(e.card);
  }

  // ---------- 永続化 ----------
  function serialize(deck) {
    // カードデータ本体は Scryfall キャッシュ側にあるので、名前と手動役割だけ保存
    const z = l => l.map(e => ({ name: e.name, qty: e.qty, manualRoles: e.manualRoles || null }));
    return { name: deck.name, format: deck.format, archetype: deck.archetype, main: z(deck.main), side: z(deck.side) };
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
    const manual = !!(e.manualRoles && e.manualRoles.length);
    return roles.map(r => {
      const R = Roles.ROLE_MAP[r];
      return `<span class="chip ${manual ? 'manual' : ''}" style="background:${R.color}">${R.label}</span>`;
    }).join('');
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

    const mainN = state.main.reduce((s, e) => s + e.qty, 0);
    const sideN = state.side.reduce((s, e) => s + e.qty, 0);
    $('#mainCount').textContent = mainN;
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
      groups = Roles.PRIORITY.map(r => ({
        key: r, label: Roles.ROLE_MAP[r].label, color: Roles.ROLE_MAP[r].color,
        items: list.filter(e => Roles.primary(rolesOf(e)) === r)
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

  function renderAnalysis() {
    const entries = state.main.map(e => ({ qty: e.qty, card: e.card, roles: rolesOf(e) }));
    const a = Roles.analyze(entries, state.format, state.archetype);

    // 役割バー
    const maxScale = Math.max(a.size * 0.45, ...Object.values(a.roleCount));
    const tgtFor = id => id === 'land' ? [Math.floor(a.recLand - 1), Math.ceil(a.recLand + 1)] : a.targets[id];
    const rows = Roles.ROLES.filter(r => r.id !== 'other' || a.roleCount.other).map(r => {
      const v = a.roleCount[r.id] || 0;
      const t = a.total ? tgtFor(r.id) : null;
      const pct = x => Math.min(100, (x / maxScale) * 100);
      return `<div class="rb">
        <span>${r.label}</span>
        <div class="rb-track">
          ${t ? `<div class="rb-target" style="left:${pct(t[0])}%;width:${Math.max(0.5, pct(t[1]) - pct(t[0]))}%"></div>` : ''}
          <div class="rb-fill" style="width:${pct(v)}%;background:${r.color}"></div>
        </div>
        <span class="rb-val">${v}${t ? ` <span class="t">/ ${t[0]}–${t[1]}</span>` : ''}</span>
      </div>`;
    }).join('');
    const inter = a.targets.interaction;
    const interRow = inter ? `<div class="rb" title="単体除去＋全体除去＋打ち消し">
        <span><b>干渉 合計</b></span>
        <div class="rb-track">
          <div class="rb-target" style="left:${Math.min(100, inter[0] / maxScale * 100)}%;width:${Math.max(0.5, (inter[1] - inter[0]) / maxScale * 100)}%"></div>
          <div class="rb-fill" style="width:${Math.min(100, a.interaction / maxScale * 100)}%;background:linear-gradient(90deg,#d0503c,#5a6fd6)"></div>
        </div>
        <span class="rb-val">${a.interaction} <span class="t">/ ${inter[0]}–${inter[1]}</span></span>
      </div>` : '';
    // 主役割の構成比
    const stack = a.total ? `<div class="stack" title="主役割の構成比">${Roles.ROLES.map(r => {
      const v = a.primaryCount[r.id];
      return v ? `<div style="width:${v / a.total * 100}%;background:${r.color}" title="${r.label} ${v}枚 (${(v / a.total * 100).toFixed(0)}%)"></div>` : '';
    }).join('')}</div>` : '';
    $('#roleBars').innerHTML = stack + rows + interRow +
      '<p class="hint">点線の枠＝フォーマット/アーキタイプ別の目安。1枚が複数の役割を持つ場合はそれぞれに数えます。</p>';

    // マナカーブ
    const cmax = Math.max(1, ...a.curve);
    $('#curve').innerHTML = a.curve.map((v, i) => `<div class="cbar">
        <span class="v">${v || ''}</span>
        <div class="b" style="height:${v / cmax * 100}%"></div>
        <span class="l">${i === 7 ? '7+' : i}</span>
      </div>`).join('');
    $('#avgMV').textContent = a.nonLand ? `平均MV ${a.avgMV.toFixed(2)}（土地除く ${a.nonLand} 枚）` : '';

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
    $('#advice').innerHTML = a.advice.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('');
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
    const current = new Set(rolesOf(e));
    const auto = Roles.classify(e.card);
    pop.innerHTML = `<h4>${esc(e.card ? displayName(e.card) : e.name)}</h4>
      ${Roles.ROLES.map(r => `<label><input type="checkbox" value="${r.id}" ${current.has(r.id) ? 'checked' : ''}>
        <span class="sw" style="background:${r.color}"></span>${r.label}${auto.includes(r.id) ? ' <span class="muted">自動</span>' : ''}</label>`).join('')}
      <div class="pop-actions"><button data-pop="reset">自動判定に戻す</button><button data-pop="close" class="primary">OK</button></div>`;
    const rect = anchor.getBoundingClientRect();
    pop.hidden = false;
    const top = Math.min(window.innerHeight - pop.offsetHeight - 8, rect.bottom + 4);
    const left = Math.min(window.innerWidth - pop.offsetWidth - 8, rect.left);
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.max(8, left) + 'px';

    pop.onchange = () => {
      const checked = [...pop.querySelectorAll('input:checked')].map(i => i.value);
      const same = checked.length === auto.length && checked.every(r => auto.includes(r));
      e.manualRoles = same || !checked.length ? null : Roles.PRIORITY.filter(r => checked.includes(r));
      render();
    };
    pop.onclick = ev => {
      const act = ev.target.dataset.pop;
      if (act === 'reset') { e.manualRoles = null; render(); pop.hidden = true; }
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

  function findEntry(zone, name) { return state[zone].find(x => x.name === name); }

  // ---------- イベント ----------
  function bind() {
    // セレクト初期化
    $('#format').innerHTML = Object.entries(Roles.FORMATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    $('#archetype').innerHTML = Object.entries(Roles.ARCHETYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    $('#format').onchange = e => { state.format = e.target.value; render(); };
    $('#archetype').onchange = e => { state.archetype = e.target.value; render(); };
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
      if (r) addCard(results._cards[+r.dataset.i], 'main');
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

    // API統計
    Scryfall.onStats(s => {
      $('#apiStats').textContent = `API送信 ${s.sent} ／ キャッシュ利用 ${s.cacheHits}${s.pending ? ` ／ 待機 ${s.pending}` : ''}`;
    });
    $('#btnClearCache').onclick = () => {
      if (confirm('Scryfall のカードキャッシュを削除しますか？（デッキは消えません）')) { Scryfall.clearCache(); toast('キャッシュを削除しました'); }
    };
  }

  bind();
  render();
  resolveCards();
})();
