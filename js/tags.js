/*
 * 効果タグの判定（効果 × 発動条件）
 * オラクルテキストを能力ごと（改行ごと）に分け、
 *   - 発動条件: いつ起きるか（唱えたとき、出たとき、毎ターン、〜するたび、起動型 など）
 *   - 効果:     何が起きるか（トークン生成、ライフ回復、ドロー、除去 など）
 * を判定する。発動条件から「1回きり」か「繰り返し」かも決まる。
 * ブラウザ（window.Tags）と Node.js（require）の両方から使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tags = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ---------- 発動条件 ----------
  const TRIGGERS = {
    spell:            { label: '唱えたとき',           repeat: false },
    etb:              { label: '出たとき',             repeat: false },
    dies:             { label: '死亡時',               repeat: false },
    chapter:          { label: '章能力',               repeat: false },
    once_trigger:     { label: '条件を満たしたとき',   repeat: false },
    cast_self:        { label: '唱えたとき（誘発）',   repeat: false },
    activated_once:   { label: '起動型（使い切り）',   repeat: false },
    activated:        { label: '起動型',               repeat: true },
    loyalty:          { label: '忠誠度能力',           repeat: true },
    each_turn:        { label: '毎ターン',             repeat: true },
    attack:           { label: '攻撃するたび',         repeat: true },
    combat_damage:    { label: '戦闘ダメージを与えるたび', repeat: true },
    creature_enters:  { label: 'クリーチャーが出るたび', repeat: true },
    landfall:         { label: '土地が出るたび（上陸）', repeat: true },
    cast_trigger:     { label: '呪文を唱えるたび',     repeat: true },
    lifegain_trigger: { label: 'ライフを得るたび',     repeat: true },
    death_trigger:    { label: '他が死亡するたび',     repeat: true },
    other_trigger:    { label: '〜するたび',           repeat: true },
    static:           { label: '常在型',               repeat: true }
  };

  // ---------- 効果 ----------
  const NUM = '(a|an|one|two|three|four|five|six|seven|x|that many|cards equal)';
  const EFFECTS = [
    { id: 'token',     label: 'トークン生成', re: [/\bcreates? (a|an|one|two|three|four|five|six|x|that many|a number of|[\w-]+ )[^.]*?\btokens?\b/] },
    { id: 'lifegain',  label: 'ライフ回復',   re: [/\byou gain (\d+|x|that much|life equal|an amount)/, /\bgains? (\d+|x) life\b/, /\bcreate[^.]*\bfood\b/] },
    { id: 'draw',      label: 'ドロー',       re: [new RegExp(`\\bdraws? ${NUM}\\b[^.]*\\bcards?\\b`), /\binvestigate\b/, /\bclue tokens?\b/,
                                                 /exile the top [^.]*cards? of your library[\s\S]{0,120}?you may (play|cast)/,
                                                 /(look at|reveal) the top [\s\S]{0,160}?into your hand/, /top cards? of your library[\s\S]{0,80}?into your hand/, /\bconnives?\b/,
                                                 /(play lands and )?cast spells from the top of your library/, /you may (play|cast) [^.]*the top card of your library/] },
    { id: 'drain',     label: 'ダメージ/ドレイン', re: [/deals? [^.]*?damage to (each opponent|target player|target opponent|that player|each player|any target|target player or planeswalker)/,
                                                 /(each opponent|target opponent|target player|that player) loses (\d+|x) life/, /deals damage equal to [^.]*? to (target player|each opponent|any target|target opponent)/, /\beach opponent loses\b/] },
    { id: 'removal',   label: '除去',         re: [/(destroy|exile) (target|another target|up to (one|two|three) (other )?target|that) (?!card)[^.]*?(creature|artifact|enchantment|planeswalker|permanent|battle)/,
                                                 /deals? [^.]*?damage to (any target|(up to (one|two) )?(another )?target [^.]*?(creature|planeswalker|permanent|battle)|that (creature|permanent|planeswalker))/,
                                                 /target [^.]*?creature[^.]*? gets -(\d+|x)\/-(\d+|x)/, /\bfights? (target|another target|up to one target)/,
                                                 /target creature you control deals damage equal to its power to (another )?target/, /deals damage equal to [^.]*? to (any target|target creature|target planeswalker|up to one target)/,
                                                 /return (target|up to \w+ target) (spell or )?(nonland )?(creature|permanent|artifact|enchantment)[^.]*to (its|their) owner'?s'? hand/,
                                                 /(target|each) (player|opponent) (sacrifices|exiles) (a|an|two)/, /gain control of target/, /enchanted creature can't attack\b/, /enchanted creature doesn't untap/, /put target [^.]*on (the )?(top|bottom) of its owner's library/] },
    { id: 'wipe',      label: '全体除去',     re: [/(destroy|exile) (all|each) [^.]*?(creatures?|nonland|permanents?|artifacts?|enchantments?)\b/, /(all|each) [^.]*?creatures?[^.]*? gets? -/,
                                                 /creatures (your opponents|target player|that player) controls? gets? -/, /deals? (\d+|x) damage to each (\w+ )?(creature|other creature|creature and)/,
                                                 /damage to each opponent and each creature/, /damage to [^.]*?each creature (they|your opponents) control/, /put all [^.]*creatures [^.]*on the bottom/,
                                                 /return all (nonland |creatures|permanents)[^.]*to (its|their) owners?'? hands?/] },
    { id: 'counter',   label: '打ち消し',     re: [/\bcounter target\b/, /\bcounter (it|that spell)\b/, /exile any number of target spells/, /\bcounter all\b/] },
    { id: 'redirect',  label: '対象変更',     re: [/change the targets? of target (spell|ability|spell or ability|instant)/, /choose new targets for target (spell|ability|instant)/] },
    { id: 'discard',   label: '手札破壊',     re: [/target (player|opponent) (reveals|discards)/, /(each opponent|that player|target opponent) discards/, /look at target (player|opponent)'s hand/] },
    { id: 'mana',      label: 'マナ',         re: [/\badd (\{[wubrgcs]\}|one mana|two mana|three mana|x mana|mana of any|an amount of|\{c\}\{c\})/, /\btreasure tokens?\b/,
                                                 /tapped for mana, its controller adds/, /adds? an additional/] },
    { id: 'pump',      label: '強化',         re: [/\+1\/\+1 counters?\b/, /\bgets? \+(\d+|x)\/\+(\d+|x)/, /creatures you control get \+/, /(equipped|enchanted) creature (gets|has|gains)/,
                                                 /target creature (gets|gains) [^.]*(first strike|double strike|trample|indestructible|lifelink)/] },
    { id: 'energy',    label: 'エネルギー',   re: [/\bget (\{e\})+/, /\bget (x|that many|an amount of) \{e\}/] },
    { id: 'tutor',     label: 'サーチ',       re: [{ test: t => (t.match(/search your library( and graveyard)? for [^.]*?cards?[^.]*/g) || [])
                                                   .some(s => !/\b(land|forest|plains|island|swamp|mountain)\b/.test(s) || !/onto the battlefield/.test(s)) },
                                                 /from outside the game/] },
    { id: 'recursion', label: '墓地回収',     re: [/return [^.]*cards? from (your|a|any|target player's) graveyards? to (your hand|the battlefield)/, /return [^.]*from your graveyard (to|onto)/,
                                                 /(cast|play) [^.]*from your graveyard/, /return enchanted creature card to the battlefield/, /creature card in a graveyard/] },
    { id: 'selfmill',  label: '墓地肥やし',   re: [/\bsurveil \d/, /\byou mill\b/, /\bmills? (a|one|two|three|four|\d+|x) cards?\b/] },
    { id: 'gyhate',    label: '墓地対策',     re: [/exile (all cards from )?(target player's|each opponent's|each player's|all) graveyards?/, /exile (all )?(target )?cards? from (all |a |an opponent's )?graveyards?/, /exile target card from a graveyard/,
                                                 /\btarget card in a graveyard\b/, /search its owner's graveyard[^.]*?and exile them/] },
    { id: 'hate',      label: '妨害（ロック）', re: [/\bcosts? \{\d\} more\b/, /would cost less than \w+ mana to cast costs/, /\bcost \{\d\} more\b/, /nonbasic lands (are|don't untap)/, /\bcan't cast (spells|noncreature|creature|instant|sorcery)/,
                                                 /can't be activated/, /(each player|players|your opponents|target player) can't (cast|activate|search|gain life|draw)/, /don't cause abilities to trigger/,
                                                 /(lands|creatures|artifacts|permanents) (your opponents control )?enter (the battlefield )?tapped/, /\bdon't untap during/, /players skip/,
                                                 // 攻撃の制限（Ensnaring Bridge、Propaganda、Moat、Peacekeeper など）
                                                 /\bcreatures (with [^.]*?|without [^.]*?|your opponents control )?can't attack\b/, /no more than (one|two) creatures? can attack/] },
    { id: 'cheat',     label: '踏み倒し',     re: [/put (a|an|up to \w+|any number of|that|those|target) [^.]*?(creature|artifact|enchantment|permanent|nonland)[^.]*?cards? (from (your hand|your library|their hand|a graveyard|among them)[^.]*?)?onto the battlefield/,
                                                 /(artifact|creature|enchantment|planeswalker|permanent)( cards?|, (artifact|creature|enchantment|planeswalker|land)[\w, ]*? cards?) from (their|your) hand onto the battlefield/, /puts? that (creature )?card onto the battlefield/, /(?<!this spell )without paying (its|their) mana costs?/] },
    { id: 'extraturn', label: '追加ターン',   re: [/take an extra turn/] },
    { id: 'untap',     label: 'アンタップ',   re: [/\buntap (target|all|up to \w+ target|another target|up to \w+) (artifacts?|lands?|nonland permanents?)\b/] },
    { id: 'copy',      label: 'コピー/ストーム', re: [/\bstorm\b/, /copy (target|that|the exiled|it)[^.]*?(instant|sorcery|spell|card)/] },
    { id: 'protection', label: '保護',        re: [/(gains?|have|has) (hexproof|indestructible|shroud|protection from)/, /phases? out/, /\bregenerate\b/,
                                                 /exile [^.]*?(target|any number of target) [^.]*?(creature|permanent|nonland)[^.]*?(you control|you own)[\s\S]{0,60}?return (it|that card|them|those cards)/] }
  ];
  const EFFECT_MAP = Object.fromEntries(EFFECTS.map(e => [e.id, e]));

  // 自分が得をする効果（相手が主語の文では数えない）
  const SELF_BENEFIT = new Set(['token', 'lifegain', 'draw', 'mana', 'pump', 'energy', 'tutor', 'recursion', 'cheat']);
  const OPPONENT_SUBJECT = /^(that player|its controller|its owner|target opponent|each opponent|an opponent|that creature's controller|that permanent's controller|that spell's controller|their controller|they)\b/;

  // キーワード能力（墓地から使えるもの）は墓地回収として扱う
  const RECURSION_KEYWORDS = /\b(flashback|unearth|escape|disturb|embalm|eternalize|retrace|jump-start)\b/;
  const EVASION = /\b(flying|trample|menace|double strike|infect|shadow|can't be blocked|horsemanship|fear|intimidate|skulk)\b/;

  const clean = s => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[ \t]+/g, ' ').trim();

  function triggerOf(line, isSpell) {
    if (isSpell) return ['spell'];
    if (/^(i|ii|iii|iv|v|vi)(, (i|ii|iii|iv|v|vi))* —/.test(line)) return ['chapter'];
    if (/^[+−-]?\d+:|^[+−-]x:/.test(line)) return ['loyalty'];
    if (/^landfall\b|^whenever an? (land|land you control) enters/.test(line)) return ['landfall'];
    if (/^at the beginning of\b/.test(line)) return ['each_turn'];
    const m = line.match(/^(when|whenever)\b([^,]*)/);
    if (m) {
      const word = m[1], clause = m[2];
      const out = [];
      if (/\benters\b/.test(clause)) {
        // 自分以外（another / a creature / one or more ...）が出るたび → 繰り返し
        if (/\b(another|a|an|one or more|each|nontoken)\b[^,]*\b(creatures?|artifacts?|enchantments?|permanents?|tokens?)\b/.test(clause) &&
            !/^ (this|~)/.test(clause)) out.push('creature_enters');
        else out.push('etb');
      }
      if (/\battacks?\b/.test(clause)) out.push('attack');
      if (/deals combat damage/.test(clause)) out.push('combat_damage');
      if (/\byou cast this spell\b/.test(clause)) out.push('cast_self');
      else if (/\b(you|a player|an opponent) casts?\b/.test(clause)) out.push('cast_trigger');
      if (/\byou gain life\b/.test(clause)) out.push('lifegain_trigger');
      if (/\bdies\b|put into (a|your) graveyard from the battlefield/.test(clause)) {
        out.push(/\b(another|a|an|one or more|each|nontoken)( other| nontoken)? (creatures?|permanents?|artifacts?|tokens?|[a-z]+ creatures?)\b/.test(clause) ? 'death_trigger' : 'dies');
      }
      if (!out.length) out.push(word === 'whenever' ? 'other_trigger' : 'once_trigger');
      return [...new Set(out)];
    }
    // 起動型能力：コスト ":" 効果
    const colon = line.indexOf(':');
    if (colon > 0 && colon < 90 && !line.slice(0, colon).includes('"')) {
      const cost = line.slice(0, colon);
      if (/\{|\bsacrifice\b|\bdiscard\b|\bpay\b|\bremove\b|\btap\b|\bexile\b|\breturn\b/.test(cost)) {
        // 自分自身を生け贄に捧げる起動型能力は1回きり（"sacrifice a creature" などは繰り返せる）
        const selfSac = /\bsacrifice (?!(a|an|another|two|three|x|one or more|any number|that|target)\b)/.test(cost);
        return [selfSac ? 'activated_once' : 'activated'];
      }
    }
    return ['static'];
  }

  /**
   * card → { abilities: [{text, triggers, effects}], tags: [{effect, trigger, repeat}], evasion, power }
   */
  function analyze(card) {
    if (!card) return { abilities: [], tags: [], evasion: false, power: null };
    const faceTypes = String(card.typeLine || '').split(' // ');
    const faceTexts = String(card.oracle || '').split(/\n\/\/\n/);
    const abilities = [];
    faceTexts.forEach((faceText, fi) => {
      const type = faceTypes[fi] || faceTypes[0] || '';
      const isSpell = /\b(Instant|Sorcery)\b/.test(type);
      let prev = null;
      for (const raw of faceText.split('\n')) {
        // 能力語（"Landfall — " "Flurry — " など）は外して判定する。章能力（I — ）は残す
        const line = clean(raw).replace(/^(?!(i|ii|iii|iv|v|vi)\b)[a-z][a-z' -]{2,30} — (?=(when|whenever|at|\{|[+−-]?\d))/, m => /^landfall/.test(m) ? 'landfall ' : '');
        if (!line) continue;
        // モードの選択肢（• ...）は直前の能力の発動条件を引き継ぐ
        const triggers = /^•/.test(line) && prev ? prev : triggerOf(line, isSpell);
        if (!/^•/.test(line)) prev = triggers;
        // 相手が得をする文（"that player draws" "its controller creates" など）は、自分の利益になる効果の判定から外す
        const selfLine = line.split(/(?<=\.)\s+/).filter(sentence => {
          const m = sentence.match(/^(when|whenever|at|if|then)\b[^,]*,\s*/);
          // "Whenever enchanted Forest is tapped for mana, its controller adds..." のように、自分のパーマネントの話なら除外しない
          if (m && /\b(enchanted|equipped|this|you control)\b/.test(m[0])) return true;
          return !OPPONENT_SUBJECT.test(sentence.slice(m ? m[0].length : 0));
        }).join(' ');
        const effects = EFFECTS.filter(e => e.re.some(r => r.test(SELF_BENEFIT.has(e.id) ? selfLine : line))).map(e => e.id);
        // トレジャーだけを作るならマナ、クルーだけならドロー（トークン生成としては数えない）
        if (effects.includes('token') && /\b(treasure|clue|food|blood|map|powerstone)\b tokens?/.test(line) &&
            !/creature tokens?|\d+\/\d+/.test(line)) effects.splice(effects.indexOf('token'), 1);
        // 全体除去だけの能力は単体除去から外す
        if (effects.includes('wipe') && effects.includes('removal') && !/\b(target|that)\b/.test(line)) effects.splice(effects.indexOf('removal'), 1);
        if (RECURSION_KEYWORDS.test(line) && !effects.includes('recursion')) effects.push('recursion');
        if (effects.length) abilities.push({ text: line, triggers, effects });
      }
    });
    const seen = new Set();
    const tags = [];
    for (const a of abilities) for (const t of a.triggers) for (const e of a.effects) {
      const k = e + '@' + t;
      if (seen.has(k)) continue;
      seen.add(k);
      tags.push({ effect: e, trigger: t, repeat: TRIGGERS[t].repeat });
    }
    const kw = (card.keywords || []).join(' ').toLowerCase();
    const evasion = EVASION.test(kw) || /can't be blocked/.test(clean(card.oracle));
    return { abilities, tags, evasion, power: card.power };
  }

  const tagLabel = t => `${EFFECT_MAP[t.effect].label} × ${TRIGGERS[t.trigger].label}`;

  return { TRIGGERS, EFFECTS, EFFECT_MAP, analyze, tagLabel };
});
