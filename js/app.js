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
  /** 小カテゴリの横に添える大事な属性（例: 単体除去 12（追放 4）、呪文干渉 6（継続 2）） */
  function subNote(id) {
    const count = pred => state.main.filter(e => e.card && rolesOf(e).includes(id) && Roles.inspect(e.card).tags.some(pred)).reduce((s, e) => s + e.qty, 0);
    const d = t => t.detail || {};
    let n = 0, label = '';
    if (id === 'removal' || id === 'wipe') { n = count(t => (t.effect === 'removal' || t.effect === 'wipe') && d(t).action === 'exile'); label = '追放'; }
    else if (['spell', 'ability', 'action', 'manalock', 'combat'].includes(id)) { n = count(t => t.detail && t.repeat); label = '継続'; }
    else if (id === 'discard' || id === 'gyhate') { n = count(t => t.detail && t.speed === 'instant'); label = 'インスタント'; }
    else if (id === 'fastmana') {
      // 今すぐマナが増える（カード1枚と引き換えのファストマナや、おまけの宝物）枚数
      n = state.main.filter(e => e.card && rolesOf(e).includes(id) && (Roles.inspect(e.card).fast || []).some(f => f.now)).reduce((s, e) => s + e.qty, 0);
      label = '今すぐ増える';
    }
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
    const sig = list.map(e => `${e.qty}:${e.card.name}:${catOf(e)}`).sort().join('|') + '#' + combos.map(c => c.name).join('|') + '#v3';
    if (simCache.sig !== sig) {
      simCache = { sig, result: null, pending: true };
      box.innerHTML = list.length ? '<p class="hint">一人回し中…</p>' : '';
      setTimeout(() => {
        if (simCache.sig !== sig) return;
        let r = null;
        // 特殊地形・土地への対策札（マナ妨害）を、何ターン目に唱えられるかも見る
        const groups = { land: list.filter(e => Roles.inspect(e.card).roles.includes('manalock')).map(e => e.card.name) };
        // 行動干渉は1枚ずつ（カードごとに最速で着地するターンが違うため）
        list.filter(e => Roles.inspect(e.card).roles.includes('action')).forEach(e => { groups['act:' + e.card.name] = [e.card.name]; });
        try { r = ManaSim.simulate(list.map(e => ({ qty: e.qty, card: e.card, cat: catOf(e) })), { combos, groups }); } catch (err) { console.error(err); }
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
      ${brow('土地（枚）', (s, t) => r[s].lands[t - 1].n)}
      ${brow('うち基本土地', (s, t) => r[s].lands[t - 1].basic)}
      ${brow('アーティファクト', (s, t) => B(s, t).artifact)}
      ${brow('エンチャント', (s, t) => B(s, t).enchantment)}
      ${brow('PW', (s, t) => B(s, t).planeswalker)}
      ${brow('出せるマナ', (s, t) => r[s].avg[t - 1])}
      ${r.hasDisrupt ? brow('妨害を構えられた', (s, t) => r[s].held[t - 1], pctTxt) : ''}
      ${r.comboNames && r.comboNames.length ? brow('コンボがそろった', (s, t) => r[s].combo[t - 1], pctTxt) : ''}
      </table></div>
      ${TT.includes(4) ? cardBreakdownHTML(topCards(r.play.names), Object.assign({ lands: r.play.lands[3].n }, r.play.board[3]), '先手') : ''}
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

    html += `<p class="hint">相手が何もしない前提で、マリガンなし・7枚キープで${r.iters.toLocaleString()}回一人回しした結果。妨害のインスタント・ソーサリーは唱えずに構えたものとして数え（妨害のパーマネントは唱えて盤面に置きます）、効果を読み取れないカードは「唱えた」ことだけを記録しています。カードの使い方は簡単なルールで決めているので、上手な人が回すより少し低めに出ることがあるよ。</p>`;
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
        ${info.back.tags.map(t => `<div class="tag back k-${t.kind}"><span class="tag-kind">${Tags.KINDS[t.kind] || ''}</span><span>${esc(Tags.tagLabel(t))}</span></div>`).join('')}`
      : '';
    const KIND_JA = { treasure: '宝物・落とし子', sacrifice: '生け贄', exile: '手札から追放', ritual: '儀式' };
    const COLOR_JA = { any: '好きな色', W: '白', U: '青', B: '黒', R: '赤', G: '緑', C: '無色' };
    const fastHTML = (info.fast || []).length
      ? `<div class="muted" style="margin-top:6px">即席マナ（1回きりのマナ）</div>${info.fast.map(f =>
        `<div class="tag k-fast"><span class="tag-kind">${esc(KIND_JA[f.kind] || f.kind)}</span><span>${f.amount}マナ・${COLOR_JA[f.color] || f.color}${f.combat ? '（攻撃・戦闘ダメージで）' : ''}
          <div class="tag-detail">${f.cardCost ? 'カード1枚を使う' : 'おまけで出る'} ／ ${f.now ? '今すぐマナが増える' : '払ったマナをあとにずらす'} ／ ${f.spell ? '呪文として唱える' : '唱えない'}</div></span></div>`).join('')}`
      : '';
    const ultHTML = info.ult
      ? `<div class="muted" style="margin-top:6px">奥義（出たターンには起動できない忠誠度能力。役割の枚数やカテゴリには数えないよ）</div>
        <div class="muted">役割: ${info.ult.allRoles.map(r => esc((Roles.ROLE_MAP[r] || {}).label || r)).join('・') || 'なし'}</div>
        ${info.ult.tags.map(t => `<div class="tag back k-activated"><span class="tag-kind">奥義</span><span>${esc(Tags.EFFECT_MAP[t.effect].label)}</span></div>`).join('')}`
      : '';
    if (!info.tags.length) return `<div class="tag-list"><div class="muted">検出した効果タグはありません</div>${fastHTML}${backHTML}${ultHTML}</div>`;
    const L = Roles.DISRUPT_LABELS;
    const detail = t => {
      if (!t.detail) return '';
      const d = t.detail;
      const parts = [L.action[d.action] || d.action, d.types.map(x => L.types[x] || x).join('・'), L.targeting[d.targeting],
        d.scope === 'all' ? '全体' : d.scope === 'multi' ? '複数' : '', d.cond ? `条件: ${d.cond}` : '',
        d.gives ? `相手に${d.gives === 'token' ? 'トークン' : d.gives === 'land' ? '土地' : 'ライフ'}` : '', d.how ? `干渉の仕方: ${L.how[d.how]}` : '', L.speed[t.speed] || ''];
      return `<div class="tag-detail">${parts.filter(Boolean).map(esc).join(' ／ ')}</div>`;
    };
    const TOKEN_JA = { creature: 'クリーチャー', treasure: '宝物', clue: '手掛かり', food: '食物', blood: '血', map: '地図', powerstone: 'パワーストーン', incubator: 'インキュベーター', role: '役割', copy: 'コピー', other: 'その他' };
    const tokens = info.tokens.length ? `<div class="muted" style="margin-top:4px">生成するトークン</div>${info.tokens.map(k =>
      `<div class="tag ${k.who === 'opponent' ? 'once' : 'rep'}"><span class="tag-kind">${k.who === 'opponent' ? '相手' : '自分'}</span>${esc(TOKEN_JA[k.kind] || k.kind)}${k.pt ? ` ${esc(k.pt)}` : ''}</div>`).join('')}` : '';
    return `<div class="tag-list"><div class="muted">検出した効果タグ（${info.speed === 'instant' ? 'インスタント速度で動ける' : 'ソーサリー速度'}）</div>${info.tags.map(t =>
      `<div class="tag k-${t.kind}"><span class="tag-kind">${Tags.KINDS[t.kind] || ''}</span><span>${esc(Tags.tagLabel(t))}${detail(t)}</span></div>`).join('')}${tokens}${fastHTML}${backHTML}${ultHTML}</div>`;
  }

  // ---------- 上位デッキへの対策（フェアデッキを含む） ----------
  // 山札 N 枚から n 枚見て、K 枚ある対処札を1枚以上引く確率
  function atLeastOne(N, K, n) {
    if (K <= 0) return 0;
    let p = 1;
    for (let i = 0; i < n; i++) p *= Math.max(0, N - K - i) / (N - i);
    return 1 - p;
  }
  // 盤面に出ているカード名と登場率（3・4・5ターン目）。平均2体/個以下なら並べ、多いときは折りたたむ
  const BOARD_TYPES = [['land', '土地', 'lands'], ['creature', 'クリーチャー', 'creatures'], ['artifact', 'アーティファクト', 'artifact'], ['enchantment', 'エンチャント', 'enchantment'], ['planeswalker', 'PW', 'planeswalker']];
  // manasim の names（種類 → 名前 → ターンごとの率）を、ベンチマークと同じ [{name, r:[3T,4T,5T]}] の形にする
  function topCards(names) {
    return Object.fromEntries(BOARD_TYPES.map(([k]) => [k, Object.entries((names || {})[k] || {})
      .map(([name, v]) => ({ name, r: [v[2] || 0, v[3] || 0, v[4] || 0] }))
      .filter(x => Math.max(...x.r) >= 0.05).sort((a, b) => b.r[1] - a.r[1]).slice(0, 8)]));
  }
  function cardBreakdownHTML(cards, b4, note) {
    if (!cards) return '';
    const pctS = x => `${Math.round(x * 100)}%`;
    const rows = BOARD_TYPES.map(([k, label, bk]) => {
      const list = cards[k] || [];
      if (!list.length) return '';
      const avg = b4[bk] || 0;
      const items = list.map(x => `${esc(x.name)} <span class="muted">${x.r.map(pctS).join('/')}</span>`).join('、');
      const head = `${label}（4Tで平均${avg.toFixed(1)}）`;
      return avg <= 2 ? `<div class="bd-row"><b>${head}</b>: ${items}</div>`
        : `<details class="bd-more"><summary>${head}の内訳を見る</summary><div class="bd-row">${items}</div></details>`;
    }).join('');
    return rows ? `<div class="mu-sub">盤面に出ているカード（3T/4T/5Tに戦場にある率${note ? '・' + note : ''}）</div>${rows}` : '';
  }
  const topNames = (cards, k, n = 2) => ((cards || {})[k] || []).slice(0, n).map(x => `${x.name} ${Math.round(x.r[1] * 100)}%`).join('・');

  // 対策の種類（相手の4ターン目の盤面から、必要なものだけ出す）
  const NEED_LABEL = { creature: 'クリーチャー除去', wipe: '全体除去', artifact: 'アーティファクト対策', enchantment: 'エンチャント対策', planeswalker: 'PW対策', spell: '打ち消し・手札破壊', graveyard: '墓地対策', land: '特殊地形・土地対策', action: '行動干渉' };
  // 行動干渉: 止める行動の種類 → 一人回しで数えた行動。フェッチランドの生け贄起動によるサーチは軽く数える
  const ACT_KEYS = { library: ['fetch', 'search'], draw: ['draw'], lifegain: ['life'], extraturn: ['extra'] };
  const ACT_W = { fetch: 0.3, search: 1, draw: 1, life: 1, extra: 1 };
  const ACT_LABEL = { library: 'サーチ', draw: '追加のドロー', lifegain: 'ライフ回復', extraturn: '追加ターン' };
  // カードが止める行動の種類
  function actionTypes(card) {
    const out = new Set();
    Roles.inspect(card).tags.forEach(t => { if (t.effect === 'hate' && t.detail) (t.detail.types || []).forEach(y => { if (ACT_KEYS[y]) out.add(y); }); });
    return [...out];
  }
  // 相手が from ターン目以降に行う行動の回数（重み付き）。acts は1ターン目からの配列
  function actRemain(acts, types, from) {
    let s = 0;
    for (let t = Math.max(1, from); t <= acts.length; t++) types.forEach(y => ACT_KEYS[y].forEach(k => { s += ACT_W[k] * (acts[t - 1][k] || 0); }));
    return s;
  }
  // 全体除去で相手の盤面から平均何体巻き込めるか（ダメージ型はタフネス1〜3以下の体数で見積もる）
  function wipeKills(card, b) {
    const info = Roles.inspect(card);
    const ab = info.abilities.find(a => a.effects.includes('wipe'));
    if (!ab) return null;
    const dm = ab.text.match(/deals? (\d+) damage to each creature/) || ab.text.match(/(?:all|each) [^.]*?creatures?[^.]*? gets? -(\d+)\/-\d+/);
    if (dm) { const n = +dm[1]; return n >= 4 ? b.creatures : b['t' + Math.max(1, n)]; }
    return b.creatures;
  }
  // 土地への対策札の種類
  function landHateKind(card) {
    const t = Tags.playableOracle(card).toLowerCase();
    if (/nonbasic lands are mountains/.test(t)) return '特殊地形を山に';
    if (/nonbasic lands don't untap/.test(t)) return '特殊地形をアンタップさせない';
    if (/tapped for two or more mana/.test(t)) return '2マナ以上の土地を1マナに';
    if (/lose all land types/.test(t)) return '指定した土地の能力を消す';
    if (/land (is|becomes) an? /.test(t)) return '土地のタイプを変える';
    if (/(destroy|exile)[^.]*\bland/.test(t)) return /nonbasic/.test(t) ? '特殊地形を破壊' : '土地破壊';
    return 'マナ妨害';
  }
  // 相手の表: 3〜5ターン目それぞれに行う行動（どれかのターンで平均0.05回以上のものだけ）
  function actRows(sim, brow) {
    if (!sim.play.acts || !sim.draw.acts) return '';
    const R = [['fetch', 'フェッチ（回）'], ['search', 'サーチ（呪文・能力）'], ['draw', '追加のドロー（枚）'], ['life', 'ライフ回復（回）'], ['extra', '追加ターン（回）']];
    return R.filter(([k]) => [2, 3, 4].some(t => (sim.play.acts[t] || {})[k] >= 0.05 || (sim.draw.acts[t] || {})[k] >= 0.05))
      .map(([k, label]) => brow(label, (s, i) => (sim[s].acts[i + 2] || {})[k] || 0)).join('');
  }
  function renderMatchups(cmp) {
    const tips = [];
    const box = $('#matchBox');
    const meta = cmp && cmp.bench && cmp.bench.meta;
    if (!meta) { box.innerHTML = '<p class="hint">上の「上位デッキとの比較」でフォーマットを選ぶと、環境の上位デッキ（シェア3%以上）への対策を表示します。</p>'; return tips; }
    if (!meta.some(m => m.sim && m.sim.play && m.sim.play.board)) { box.innerHTML = '<p class="hint">ベンチマークのデータが古い形式なので、次回の集計後に表示されます。</p>'; return tips; }
    const mainE = state.main.filter(e => e.card), sideE = state.side.filter(e => e.card);
    if (!mainE.length) { box.innerHTML = ''; return tips; }
    const deckN = mainE.reduce((s, e) => s + e.qty, 0);
    const sim = simCache.result;
    const myArch = cmp.group && cmp.group.name;
    const pct = x => `${Math.round(x * 100)}%`;
    const n1 = x => (+x).toFixed(1);
    const short = list => list.length > 3 ? list.slice(0, 3).join('、') + ' など' : list.join('、');
    const qtyOf = l => l.reduce((s, e) => s + e.qty, 0);
    const HOW = { removal: '除去', counter: '打ち消し', discard: '手札破壊' };

    const rows = meta.filter(m => m.share >= 0.03 && m.name !== myArch && m.sim && m.sim.play && m.sim.play.board).sort((a, b) => b.share - a.share);
    const html = rows.map(m => {
      const S = m.sim.play, b4 = S.board[1];
      const perT = b4.creatures ? b4.toughness / b4.creatures : 0;
      const pseudo = { creature: { type: 'Creature', toughness: String(Math.round(perT) || 1), mv: null }, artifact: { type: 'Artifact' }, enchantment: { type: 'Enchantment' }, planeswalker: { type: 'Planeswalker' } };
      // 必要な対策（相手の4ターン目の盤面から）
      const needs = [];
      if (b4.creatures >= 0.5) needs.push('creature');
      if (S.wide[1] >= 0.3 || b4.creatures >= 2.5) needs.push('wipe');
      ['artifact', 'enchantment'].forEach(k => { if (b4[k] >= 0.3) needs.push(k); });
      if (b4.planeswalker >= 0.2) needs.push('planeswalker');
      const thin = b4.creatures < 1 && b4.artifact + b4.enchantment + b4.planeswalker < 0.5;
      if (thin || (S.combo && S.combo[1] >= 0.2)) needs.push('spell');
      if (m.graveyard) needs.push('graveyard');
      // 土地への対策で4ターン目の出せるマナが3割以上減る相手（特殊地形・2マナ土地に頼るデッキ）
      // 土地への依存度: Blood Moon（マナが25%以上減るか、土地の7割以上が特殊地形）、Damping Sphere（25%以上減る）、
      //   土地を1枚壊すと45%以上減る（普通のデッキは3割前後）。Back to Basics は特殊地形を使うほぼ全デッキに効くので判定には使わない
      const L4 = S.lands && S.lands[1];
      const landWhy = [];
      if (L4 && L4.alt.normal > 0) {
        const drop = k => 1 - L4.alt[k] / L4.alt.normal;
        const nonbasic = L4.n ? 1 - L4.basic / L4.n : 0;
        if (drop('moon') >= 0.25) landWhy.push(`Blood Moon下でマナ${n1(L4.alt.normal)}→${n1(L4.alt.moon)}`);
        else if (nonbasic >= 0.7) landWhy.push(`土地の${pct(nonbasic)}が特殊地形（Blood Moon下で色を失う）`);
        if (drop('sphere') >= 0.25) landWhy.push(`Damping Sphere下でマナ${n1(L4.alt.normal)}→${n1(L4.alt.sphere)}`);
        if (drop('ld') >= 0.45) landWhy.push(`土地を1枚壊すとマナ${n1(L4.alt.normal)}→${n1(L4.alt.ld)}`);
      }
      if (landWhy.length) needs.push('land');
      // 行動干渉: 相手が3〜6ターン目にサーチ・追加のドロー・ライフ回復・追加ターンを（重み付きで）合計1回以上行う
      const actsOpp = m.sim.draw && m.sim.draw.acts; // 自分が先手のときの相手（後手）
      const actWhy = [], actNeed = [];
      if (actsOpp) Object.keys(ACT_KEYS).forEach(y => {
        const r = actRemain(actsOpp, [y], 3);
        if (r >= 1) { actNeed.push(y); actWhy.push(`${ACT_LABEL[y]}${y === 'library' ? `（フェッチ以外${n1(actRemain(actsOpp.map(a => ({ search: a.search })), ['library'], 3))}回）` : ''}`); }
      });
      if (actNeed.length) needs.push('action');
      const fits = (e, need) => {
        const info = Roles.inspect(e.card);
        if (need === 'creature') { const w = Roles.answerWhy(e.card, pseudo.creature); return w && w.ok && w.how === 'removal' && info.roles.includes('removal'); }
        if (need === 'wipe') return info.roles.includes('wipe') && info.tags.some(t => t.effect === 'wipe' && t.detail && t.detail.types.includes('creature'));
        if (pseudo[need]) { const w = Roles.answerWhy(e.card, pseudo[need]); return w && w.ok && w.how === 'removal'; }
        if (need === 'spell') return info.tags.some(t => t.effect === 'counter' || t.effect === 'discard');
        if (need === 'graveyard') return info.roles.includes('gyhate');
        if (need === 'land') return info.roles.includes('manalock');
        if (need === 'action') return info.roles.includes('action') && actionTypes(e.card).some(y => actNeed.includes(y));
        return false;
      };
      const cells = needs.map(n => {
        const mn = mainE.filter(e => fits(e, n)), sd = sideE.filter(e => fits(e, n));
        let chance = null;
        if (n === 'action') return { n, mn, sd, main: qtyOf(mn), side: qtyOf(sd), chance };
        if (mn.length && n === 'land' && sim && sim.play.groups && sim.play.groups.land) {
          chance = sim.play.groups.land[Math.min(4, sim.turns) - 1]; // コスト軽減も込みで、4ターン目までに手札にあって唱えられる率
        } else if (mn.length) {
          const minCmc = Math.min(...mn.map(e => Math.round(e.card.cmc || 0)));
          const manaOk = sim ? (sim.play.ge[Math.min(4, sim.turns) - 1][Math.min(minCmc, 11)] || 0) : 1;
          chance = atLeastOne(deckN, qtyOf(mn), 10) * manaOk; // 先手4ターン目までに見る10枚
        }
        return { n, mn, sd, main: qtyOf(mn), side: qtyOf(sd), chance };
      });
      // 行動干渉の登場ターン: 最速（マナ総量。一人回しでコスト軽減・加速により早く唱えられる率が5%以上ならそのターン）、+1、+2ターンに
      // 着地したとき、相手がそれ以降に行う行動の回数。先手なら相手のそのターンから、後手なら次のターンから止められる
      const actTiming = e => {
        const types = actionTypes(e.card).filter(y => actNeed.includes(y));
        let F = Math.max(1, Math.round(e.card.cmc || 0));
        const gr = sim && sim.play.groups && sim.play.groups['act:' + e.card.name];
        if (gr) { const i = gr.findIndex(x => x >= 0.05); if (i >= 0) F = Math.max(1, Math.min(F, i + 1)); }
        const at = [F, F + 1, F + 2].map(L => ({ L, play: actRemain(m.sim.draw.acts, types, L), draw: actRemain(m.sim.play.acts, types, L + 1) }));
        return { types, F, at };
      };
      const ac = cells.find(c => c.n === 'action');
      if (ac) {
        const all = [...ac.mn, ...ac.sd];
        const why = `3ターン目以降も${actWhy.join('・')}を行う`;
        // 行動干渉がないことは指摘しない（多くの相手が少しはドロー・サーチするので、毎回出ると邪魔になる）
        if (all.length && all.every(e => actTiming(e).at[0].play < 0.5)) tips.push({ level: 'info', text: `対${m.name}（${pct(m.share)}）: ${why}けど、${short(all.map(e => displayName(e.card)))}は最速で着地しても止められる行動が平均0.5回未満。対策としては間に合いにくいかも。` });
      }
      // アドバイス
      const cr = cells.find(c => c.n === 'creature');
      if (cr && !cr.main && !cr.side) tips.push({ level: 'bad', text: `対${m.name}（${pct(m.share)}）: 4ターン目にクリーチャーが平均${n1(b4.creatures)}体並ぶのに、クリーチャー除去がメインにもサイドにもないよ。` });
      const wp = cells.find(c => c.n === 'wipe');
      if (wp && !wp.main && !wp.side && S.wide[1] >= 0.5 && m.share >= 0.05) tips.push({ level: 'info', text: `対${m.name}（${pct(m.share)}）: 4ターン目に3体以上並ぶ率が${pct(S.wide[1])}（タフネス2以下が平均${n1(b4.t2)}体）。全体除去がないので、サイドに検討の余地があるかも。` });
      const ld = cells.find(c => c.n === 'land');
      if (ld && L4) {
        const msg = `対${m.name}（${pct(m.share)}）: 4ターン目に${landWhy.join('、')}（土地${n1(L4.n)}枚のうち基本土地${n1(L4.basic)}枚）。`;
        if (!ld.main && !ld.side) { if (m.share >= 0.05) tips.push({ level: 'info', text: msg + '特殊地形・土地対策はメインにもサイドにもないよ。' }); }
        else tips.push({ level: 'info', text: msg + `対策札は メイン${ld.main}/サイド${ld.side}枚。` });
      }
      // 盤面に平均0.5個以上残るパーマネント・墓地・呪文中心の相手に、対策が1枚もないとき
      cells.filter(c => !c.main && !c.side && (['graveyard', 'spell'].includes(c.n) || (['artifact', 'enchantment', 'planeswalker'].includes(c.n) && b4[c.n] >= 0.5))).forEach(c => {
        const nm = ['artifact', 'enchantment', 'planeswalker'].includes(c.n) ? topNames(S.cards, c.n) : '';
        const what = ['artifact', 'enchantment', 'planeswalker'].includes(c.n) ? `4ターン目に${{ artifact: 'アーティファクト', enchantment: 'エンチャント', planeswalker: 'PW' }[c.n]}が平均${n1(b4[c.n])}個（${nm || '内訳不明'}）あるのに、` : '';
        tips.push({ level: 'warn', text: `対${m.name}（${pct(m.share)}）: ${what}${NEED_LABEL[c.n]}がメインにもサイドにもないよ。` });
      });
      // 腐りやすい枠（相手の4ターン目の盤面に対象がほとんどない妨害）
      const opp = { perm: { creature: b4.creatures, artifact: b4.artifact, enchantment: b4.enchantment, planeswalker: b4.planeswalker, battle: 0 }, graveyard: m.graveyard };
      const MIN = { creature: 1, artifact: 0.3, enchantment: 0.3, planeswalker: 0.2, battle: 0.2 };
      const dead = mainE.filter(e => Roles.inspect(e.card).cat === 'disrupt' && Roles.deadAgainst(e.card, opp, MIN));
      const deadN = qtyOf(dead);
      const good = sideE.filter(e => !Roles.deadAgainst(e.card, opp, MIN) && needs.some(n => fits(e, n)));
      if (deadN >= 2) tips.push({ level: 'info', text: `対${m.name}（${pct(m.share)}）では、メインの${short(dead.map(e => displayName(e.card)))}（計${deadN}枚）が腐りやすいよ。${good.length ? `サイドの${short(good.map(e => displayName(e.card)))}と入れ替える候補だね。` : 'サイドに入れ替え先になるカードが見当たらないかも。'}` });

      const cls = c => (c.main + c.side) === 0 ? 'c-low' : c.main === 0 ? 'c-near' : 'c-ok';
      const list = (l, n) => l.length ? l.map(e => {
        let extra = '';
        if (n === 'wipe') { const k = wipeKills(e.card, b4); if (k != null) extra = `（平均${n1(k)}体）`; }
        else if (n === 'spell') extra = `（${Roles.inspect(e.card).tags.some(t => t.effect === 'counter') ? '打ち消し' : '手札破壊'}）`;
        else if (n === 'land') extra = `（${landHateKind(e.card)}）`;
        else if (n === 'action') {
          const tm = actTiming(e);
          extra = `（${tm.types.map(y => ACT_LABEL[y]).join('・')}。止められる回数 先手/後手: ${tm.at.map((a, i) => `${i ? '' : '最速'}${a.L}T ${n1(a.play)}/${n1(a.draw)}回${a.play >= 0.5 ? '◎' : ''}`).join('・')}）`;
        }
        return `${esc(displayName(e.card))}×${e.qty}<span class="muted">${extra}</span>`;
      }).join('、') : '<span class="bad-t">なし</span>';
      // クリーチャー除去で、ダメージ量や条件で届かないもの
      const near = [...mainE, ...sideE].map(e => ({ e, w: Roles.answerWhy(e.card, pseudo.creature) })).filter(x => x.w && !x.w.ok && x.w.reason !== 'type' && b4.creatures >= 0.5)
        .map(x => `${esc(displayName(x.e.card))}（${esc(x.w.note)}）`);
      const B = (side, i) => m.sim[side].board[i];
      const brow = (label, f, fmt = n1) => `<tr><td>${label}</td>${[0, 1, 2].map(i => `<td>${fmt(f('play', i))}<span class="muted">/${fmt(f('draw', i))}</span></td>`).join('')}</tr>`;
      const oppTable = `<div class="sim-scroll"><table class="meta-table sim-table"><tr><th>相手（先手/後手）</th><th>3T</th><th>4T</th><th>5T</th></tr>
        ${brow('クリーチャー（体）', (s, i) => B(s, i).creatures)}
        ${brow('合計パワー', (s, i) => B(s, i).power)}
        ${brow('タフネス1以下', (s, i) => B(s, i).t1)}
        ${brow('タフネス2以下', (s, i) => B(s, i).t2)}
        ${brow('タフネス3以下', (s, i) => B(s, i).t3)}
        ${brow('3体以上並ぶ率', (s, i) => m.sim[s].wide[i], pct)}
        ${brow('アーティファクト', (s, i) => B(s, i).artifact)}
        ${brow('エンチャント', (s, i) => B(s, i).enchantment)}
        ${brow('PW', (s, i) => B(s, i).planeswalker)}
        ${brow('出せるマナ', (s, i) => m.sim[s].mana[i])}
        ${m.sim.play.lands ? brow('土地（枚）', (s, i) => m.sim[s].lands[i].n) + brow('うち基本土地', (s, i) => m.sim[s].lands[i].basic) +
          brow('Blood Moon下のマナ', (s, i) => m.sim[s].lands[i].alt.moon) + brow('Damping Sphere下', (s, i) => m.sim[s].lands[i].alt.sphere) +
          brow('Back to Basics下', (s, i) => m.sim[s].lands[i].alt.b2b) + brow('土地1枚破壊後', (s, i) => m.sim[s].lands[i].alt.ld) : ''}
        ${actRows(m.sim, brow)}
        ${m.sim.hasDisrupt ? brow('妨害を構える', (s, i) => m.sim[s].held[i], pct) : ''}
        ${m.sim.combos && m.sim.combos.length ? brow('コンボがそろう', (s, i) => m.sim[s].combo[i], pct) : ''}
        </table></div>`;
      const body = `<div class="mu-body">
          ${oppTable}
          ${cardBreakdownHTML(S.cards, Object.assign({ lands: L4 ? L4.n : 0 }, b4), '先手')}
          ${cells.map(c => `<div class="mu-sub">${NEED_LABEL[c.n]}${c.n === 'action' ? '<span class="muted">（最速・+1T・+2Tに着地したとき、相手がそれ以降に行う行動の回数。フェッチランドの生け贄起動は0.3回分、◎は0.5回以上）</span>' : ''}${c.chance != null ? `<span class="muted">（4Tまでに手札にあって唱えられる率 ${pct(c.chance)}・先手${c.n === 'land' && sim && sim.play.groups && sim.play.groups.land ? `。2T/3T: ${pct(sim.play.groups.land[1])}/${pct(sim.play.groups.land[2])}、コスト軽減込み` : ''}）</span>` : ''}</div>
            <div>メイン: ${list(c.mn, c.n)}</div><div class="muted">サイド: ${c.sd.length ? list(c.sd, c.n) : 'なし'}</div>`).join('')}
          ${near.length ? `<div class="mu-sub">数えなかったクリーチャー除去（相手のクリーチャーは平均タフネス${n1(perT)}）</div><ul class="mu-list">${[...new Set(near)].map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
          ${deadN ? `<div class="mu-sub">腐りやすい枠</div><div>${esc(dead.map(e => `${displayName(e.card)}×${e.qty}`).join('、'))}${good.length ? `<br>→ 入れ替え候補（サイド）: ${esc(good.map(e => `${displayName(e.card)}×${e.qty}`).join('、'))}` : '<br><span class="muted">サイドに入れ替え先が見当たらない</span>'}</div>` : ''}
        </div>`;
      const summary = `4T: 土地${L4 ? n1(L4.n) : '?'}枚（基本${L4 ? n1(L4.basic) : '?'}）・クリーチャー${n1(b4.creatures)}体（P計${n1(b4.power)}・タフネス2以下${n1(b4.t2)}）${b4.artifact >= 0.3 ? `・A${n1(b4.artifact)}` : ''}${b4.enchantment >= 0.3 ? `・E${n1(b4.enchantment)}` : ''}${b4.planeswalker >= 0.2 ? `・PW${n1(b4.planeswalker)}` : ''}${m.sim.combos && m.sim.combos.length ? `・コンボ${pct(S.combo[1])}` : ''}`;
      return `<details class="mu" data-arch="${esc(m.name)}" ${openArch.has(m.name) ? 'open' : ''}><summary>
        <div class="mu-head"><b>${esc(m.name)}</b> <span class="num">${pct(m.share)}</span><span class="mu-toggle muted"></span></div>
        <div class="muted">${summary}</div>
        <div class="mu-threats">${cells.map(c => `<span class="mu-t ${cls(c)}">${NEED_LABEL[c.n]} <b>${c.main}</b><span class="muted">/${c.side}</span></span>`).join('')}</div>
        ${landWhy.length ? `<div class="muted">土地への依存: ${esc(landWhy.join('、'))}</div>` : ''}
        ${actWhy.length ? `<div class="muted">3T以降の行動: ${esc(actWhy.join('、'))}</div>` : ''}
        ${deadN ? `<div class="muted">腐りやすい枠あり（${deadN}枚）</div>` : ''}
      </summary>${body}</details>`;
    }).join('');
    box.innerHTML = (html || '<p class="hint">シェア3%以上の上位デッキがありません</p>') +
      `<p class="hint">各デッキの代表リストを相手が何もしない前提で一人回しした、4ターン目の盤面（先手）から必要な対策を出しています。数字はメイン/サイドの枚数。押すと相手の3・4・5ターン目の盤面と、対策ごとのカードの一覧を開けます。クリーチャー除去は相手のクリーチャーの平均タフネスに届くか、「マナ総量N以下」の条件も見ています。腐りやすい枠＝相手の4ターン目の盤面に対象がほとんどない妨害。</p>`;
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
    // 上位デッキの集計が古い形式（繰り返し/1回）のときは比較しない
    const benchNew = benchTags && Object.keys(benchTags).some(k => /:(spell|activated|triggered|static)$/.test(k));
    const KS = ['spell', 'activated', 'triggered', 'static'];
    const rows = Tags.EFFECTS.map(e => {
      const v = KS.map(k => a.tagCounts[`${e.id}:${k}`] || 0);
      const b = KS.map(k => benchNew ? benchTags[`${e.id}:${k}`] : null);
      if (!v.some(Boolean) && !b.some(x => x && x.q3)) return '';
      const cell = (x, bb) => `<td class="num">${x || ''}${bb ? ` <span class="muted">/ ${bb.median}</span>` : ''}</td>`;
      return `<tr><td>${esc(e.label)}</td>${v.map((x, i) => cell(x, b[i])).join('')}</tr>`;
    }).join('');
    root.innerHTML = rows
      ? `<table class="meta-table"><thead><tr><th>効果</th>${KS.map(k => `<th class="num">${Tags.KINDS[k]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
         <p class="hint">その効果を持つカードの枚数を、能力の種類（呪文・起動型・誘発型・常在型。総合ルール113.3の区分）ごとに数えています。${benchNew ? '「/」の右は上位デッキの中央値。' : benchTags ? '上位デッキの比較は、次回のベンチマーク集計後に表示されます。' : ''}カードの役割チップを押すと、カードごとのタグ（効果 × 発動条件）を確認できます。</p>`
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
