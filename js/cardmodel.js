/*
 * Scryfall のカードオブジェクトを、アプリで使う最小限の形に変換する。
 * ブラウザ（window.CardModel）と Node.js（require）の両方から使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CardModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

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

  /** 名前の表記ゆれを吸収したキー（MTGOの "Fire/Ice"、大文字小文字、余分な空白） */
  function nameKey(name) {
    let s = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (/[^/]\/[^/]/.test(s) && !s.includes('//')) s = s.replace(/\s*\/\s*/, ' // ');
    return s.replace(/\s*\/\/\s*/g, ' // ');
  }

  return { slim, nameKey };
});
