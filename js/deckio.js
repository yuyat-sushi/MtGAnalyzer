/*
 * MTGO 形式のインポート / エクスポート
 *  - .txt : "4 Lightning Bolt" 形式。空行（または "Sideboard" 行）以降がサイドボード
 *  - .dek : MTGO の XML 形式 <Cards CatID Quantity Sideboard Name Annotation/>
 * デッキは { main: [{name, qty}], side: [{name, qty}] } で扱う
 */
(function (global) {
  'use strict';

  function addTo(list, name, qty) {
    const ex = list.find(e => e.name.toLowerCase() === name.toLowerCase());
    if (ex) ex.qty += qty; else list.push({ name, qty });
  }

  /** MTGO .txt（Arena形式や "SB:" 接頭辞もある程度許容） */
  function parseText(text) {
    const deck = { main: [], side: [] };
    let zone = 'main';
    let seenCard = false;
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    for (let raw of lines) {
      let line = raw.trim();
      if (!line) {
        if (seenCard) zone = 'side';   // MTGO: 最初の空行でサイドへ
        continue;
      }
      if (/^\/\//.test(line) || /^#/.test(line)) continue;              // コメント
      if (/^(sideboard|サイドボード)\s*:?$/i.test(line)) { zone = 'side'; continue; }
      if (/^(deck|main ?deck|メインデッキ|commander|companion)\s*:?$/i.test(line)) { zone = 'main'; continue; }
      let z = zone;
      const sb = line.match(/^SB:\s*(.*)$/i);
      if (sb) { z = 'side'; line = sb[1]; }
      const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
      let qty = 1, name = line;
      if (m) { qty = parseInt(m[1], 10); name = m[2]; }
      // Arena形式の "(SET) 123" を除去
      name = name.replace(/\s+\([A-Z0-9]{2,6}\)\s+\S+\s*$/, '').replace(/\s+\*[A-Z]\*$/, '').trim();
      if (!name || qty <= 0) continue;
      addTo(deck[z], name, qty);
      seenCard = true;
    }
    return deck;
  }

  /** MTGO .dek（XML） */
  function parseDek(xml) {
    const deck = { main: [], side: [] };
    const re = /<Cards\b([^>]*?)\/?>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = {};
      m[1].replace(/(\w+)\s*=\s*"([^"]*)"/g, (_, k, v) => { attrs[k] = decodeXml(v); return ''; });
      const qty = parseInt(attrs.Quantity, 10) || 0;
      if (!attrs.Name || qty <= 0) continue;
      const zone = String(attrs.Sideboard).toLowerCase() === 'true' ? 'side' : 'main';
      addTo(deck[zone], attrs.Name, qty);
    }
    return deck;
  }

  function parseAuto(text, filename) {
    if (/\.dek$/i.test(filename || '') || /<Deck[\s>]/i.test(text)) return parseDek(text);
    return parseText(text);
  }

  // MTGOは分割カードを "Fire/Ice" と書く
  const mtgoName = n => n.replace(/ \/\/ /g, '/');

  /** entries: [{name, qty, mtgoId?}] */
  function toText(main, side) {
    const fmt = l => l.map(e => `${e.qty} ${mtgoName(e.name)}`).join('\n');
    let out = fmt(main);
    if (side && side.length) out += '\n\n' + fmt(side);
    return out + '\n';
  }

  function toDek(main, side) {
    const row = (e, sb) =>
      `  <Cards CatID="${e.mtgoId || 0}" Quantity="${e.qty}" Sideboard="${sb}" Name="${encodeXml(mtgoName(e.name))}" Annotation="0" />`;
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '  <NetDeckID>0</NetDeckID>',
      '  <PreconstructedDeckID>0</PreconstructedDeckID>',
      ...main.map(e => row(e, 'false')),
      ...(side || []).map(e => row(e, 'true')),
      '</Deck>',
      ''
    ].join('\r\n');
  }

  function encodeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function decodeXml(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  const DeckIO = { parseText, parseDek, parseAuto, toText, toDek };
  if (typeof module !== 'undefined' && module.exports) module.exports = DeckIO;
  else global.DeckIO = DeckIO;
})(typeof window !== 'undefined' ? window : globalThis);
