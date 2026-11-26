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
    { id: 'removal',   label: '除去',         re: [/(destroy|exile) (target|another target|up to (one|two|three) (other )?target|that) (?!card)[^.]*?(creature|artifact|enchantment|planeswalker|permanent|battle|land)/,
                                                 /deals? [^.]*?damage to (any target|(up to (one|two) )?(another )?target [^.]*?(creature|planeswalker|permanent|battle)|that (creature|permanent|planeswalker))/,
                                                 /target [^.]*?creature[^.]*? gets -(\d+|x)\/-(\d+|x)/, /\bfights? (target|another target|up to one target)/,
                                                 /target creature you control deals damage equal to its power to (another )?target/, /deals damage equal to [^.]*? to (any target|target creature|target planeswalker|up to one target)/,
                                                 /return (target|up to \w+ target) (spell or )?(nonland )?(creature|permanent|artifact|enchantment)[^.]*to (its|their) owner'?s'? hand/,
                                                 /(target|each) (player|opponent) (sacrifices|exiles) (a|an|two)/, /gain control of target/, /enchanted creature can't attack\b/, /enchanted creature doesn't untap/, /put target [^.]*on (the )?(top|bottom) of its owner's library/] },
    { id: 'wipe',      label: '全体除去',     re: [/(destroy|exile) (all|each) [^.]*?(creatures?|nonland|permanents?|artifacts?|enchantments?)\b/, /(all|each) [^.]*?creatures?[^.]*? gets? -/,
                                                 /creatures (your opponents|target player|that player) controls? gets? -/, /deals? (\d+|x) damage to each (\w+ )?(creature|other creature|creature and)/,
                                                 /damage to each opponent and each creature/, /damage to [^.]*?each creature (they|your opponents) control/, /put all [^.]*creatures [^.]*on the bottom/,
                                                 /return all (nonland |creatures|permanents)[^.]*to (its|their) owners?'? hands?/] },
    { id: 'counter',   label: '打ち消し',     re: [/\bcounter target\b/, /\bexile target spell\b/, /\bcounter (it|that spell)\b/, /exile any number of target spells/, /\bcounter all\b/] },
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
                                                 /\btarget card in a graveyard\b/, /would be put into an opponent's graveyard[^.]*?exile it\b/, /search its owner's graveyard[^.]*?and exile them/] },
    { id: 'hate',      label: '妨害（ロック）', re: [/\bcosts? \{\d\} more\b/, /would cost less than \w+ mana to cast costs/, /\bcost \{\d\} more\b/, /nonbasic lands (are|don't untap)/, /\bcan't cast (spells|noncreature|creature|instant|sorcery)/,
                                                 /can't be activated/, /(each player|players|your opponents|target player) can't (cast|activate|search|gain life|draw)/, /don't cause abilities to trigger/,
                                                 /(lands|creatures|artifacts|permanents) (your opponents control )?enter (the battlefield )?tapped/, /\bdon't untap during/, /players skip/, /tap for more than one mana produce/] },
    // 攻撃の制限（Ensnaring Bridge、Propaganda、Moat、Peacekeeper など）
    { id: 'attacklock', label: '攻撃制限',    re: [/\bcreatures (with [^.]*?|without [^.]*?|your opponents control )?can't attack\b/, /no more than (one|two) creatures? can attack/] },
    { id: 'cheat',     label: '踏み倒し',     re: [/put (a|an|up to \w+|any number of|that|those|target)\b[^.]*?\b(creature|artifact|enchantment|permanent|planeswalker|nonland)\b[^.]*?\bcards?\b[^.]*?onto the battlefield/,
                                                 /(artifact|creature|enchantment|planeswalker|permanent)( cards?|, (artifact|creature|enchantment|planeswalker|land)[\w, ]*? cards?) from (their|your) hand onto the battlefield/, { test: t => /puts? that (creature )?card onto the battlefield/.test(t) && /\bcreature card\b/.test(t) && !/\bland card\b/.test(t) }, { test: t => t.split(/(?<=\.)\s+/).some(x => /(?<!(this spell|cast it|cast this card) )without paying (its|their) mana costs?/.test(x) && !/from (your|a) graveyard/.test(x)) }] },
    { id: 'extraturn', label: '追加ターン',   re: [/take an extra turn/] },
    { id: 'untap',     label: 'アンタップ',   re: [/\buntap (target|all|up to \w+ target|another target|up to \w+) (artifacts?|lands?|nonland permanents?)\b/] },
    { id: 'copy',      label: 'コピー/ストーム', re: [/\bstorm\b/, /copy (target|that|the exiled|it)[^.]*?(instant|sorcery|spell|card)/] },
    { id: 'protection', label: '保護',        re: [/(gains?|have|has) (hexproof|indestructible|shroud|protection from)/, /phases? out/, /\bregenerate\b/,
                                                 /exile [^.]*?(target|any number of target) [^.]*?(creature|permanent|nonland)[^.]*?(you control|you own)[\s\S]{0,60}?return (it|that card|them|those cards)/] }
  ];
  const EFFECT_MAP = Object.fromEntries(EFFECTS.map(e => [e.id, e]));

  // 自分が得をする効果（相手が主語の文では数えない）
  const SELF_BENEFIT = new Set(['token', 'lifegain', 'draw', 'mana', 'pump', 'energy', 'tutor', 'recursion', 'cheat']);
  const OPPONENT_SUBJECT = /^(the [a-z' -]*?owner|that player|its controller|its owner|target opponent|each opponent|an opponent|that creature's controller|that permanent's controller|that spell's controller|their controller|they)\b/;

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
    if (!card) return { abilities: [], tags: [], tokens: [], evasion: false, power: null, speed: 'sorcery' };
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
        const tokens = tokensOf(line);
        if (effects.length || tokens.length) abilities.push({ text: line, triggers, effects, tokens, isInstant: /\bInstant\b/.test(type) });
      }
    });
    const kw = (card.keywords || []).join(' ').toLowerCase();
    const hasFlash = /\bflash\b/.test(kw) || /^flash$/m.test(clean(card.oracle));
    const seen = new Set();
    const tags = [];
    for (const a of abilities) for (const t of a.triggers) for (const e of a.effects) {
      const detail = DISRUPT_EFFECTS.has(e) ? detailOf(a.text, e) : null;
      // 妨害は処理と対象の種類が違えば別のタグとして残す（Kolaghan's Command の「破壊」と「ダメージ」など）
      const k = e + '@' + t + (detail ? `#${detail.action}:${detail.types.join(',')}` : '');
      if (seen.has(k)) continue;
      seen.add(k);
      const tag = { effect: e, trigger: t, repeat: TRIGGERS[t].repeat, speed: speedOf(t, a.isInstant, hasFlash, a.text) };
      if (detail) tag.detail = detail;
      tags.push(tag);
    }
    const tokens = abilities.flatMap(a => a.tokens || []);
    const evasion = EVASION.test(kw) || /can't be blocked/.test(clean(card.oracle));
    // カード全体の速度：インスタント・瞬速、またはマナ以外の起動型能力があればインスタント速度で動ける
    const front = String(card.typeLine || '').split(' // ')[0];
    const speed = /\bInstant\b/.test(front) || hasFlash ? 'instant' :
      abilities.some(a => a.triggers.includes('activated') && !/activate only as a sorcery/.test(a.text) && !(a.effects.length === 1 && a.effects[0] === 'mana')) ? 'instant' : 'sorcery';
    return { abilities, tags, tokens, evasion, power: card.power, speed };
  }

  // ---------- 妨害の詳細（選択先・影響範囲・処理/移動先・相手に与えるもの） ----------
  const DISRUPT_EFFECTS = new Set(['removal', 'wipe', 'counter', 'redirect', 'discard', 'gyhate', 'hate', 'attacklock']);
  const TYPE_WORDS = [
    ['creature', /\bcreatures?\b/], ['artifact', /\bartifacts?\b/], ['enchantment', /\benchantments?\b/],
    ['planeswalker', /\bplaneswalkers?\b/], ['battle', /\bbattles?\b/], ['land', /\blands?\b/]
  ];
  const ALL_PERMANENTS = ['creature', 'artifact', 'enchantment', 'planeswalker', 'battle', 'land'];

  /** 除去などの能力の文から、処理・対象の種類・選び方・範囲・条件・相手に与えるものを取り出す */
  function detailOf(line, effect) {
    const d = { action: null, types: [], targeting: null, scope: 'single', cond: null, gives: null };
    // ロック・封じ・課税：何を封じるか
    if (effect === 'hate' || effect === 'attacklock') {
      d.action = 'lock'; d.targeting = 'nontarget'; d.scope = 'all';
      const t = [];
      if (/can't be activated/.test(line)) t.push('activated ability');
      if (/don't cause abilities to trigger|abilities (can't|don't) trigger/.test(line)) t.push('triggered ability');
      if (/can't cast|can't be cast/.test(line)) t.push('spell');
      if (/from graveyards|in graveyards/.test(line)) t.push('graveyard');
      if (/costs? \{\d\} more|cost \{\d\} more|would cost less than/.test(line)) t.push('tax');
      if (/nonbasic lands|tap for more than one mana|produce \{c\}/.test(line)) t.push('mana');
      if (/can't search/.test(line)) t.push('library');
      if (/can't attack|can attack/.test(line)) t.push('attack');
      if (/don't untap|doesn't untap|enter (the battlefield )?tapped/.test(line)) t.push('untap');
      if (/can't (gain life|draw)/.test(line)) t.push('other');
      d.types = t.length ? t : ['other'];
      d.lock = lockScope(line);
      if (d.lock.length) d.cond = d.lock.map(lockLabel).join('、');
      return d;
    }
    if (effect === 'counter') {
      d.action = /\bexile (it|that spell|target spell)\b|counter target[^.]*?\. (if|exile)[^.]*?exile/.test(line) || /\bexile target spell\b/.test(line) ? 'counter_exile' : 'counter';
      d.types = [/counter target (noncreature )?spell/.test(line) ? (/noncreature/.test(line) ? 'noncreature spell' : 'spell') :
        /creature spell/.test(line) ? 'creature spell' : /(instant|sorcery)/.test(line) && /counter target (instant|sorcery)/.test(line) ? 'instant/sorcery' :
        /(activated|triggered) ability/.test(line) ? null : 'spell'].filter(Boolean);
      d.targeting = /\btarget\b/.test(line) ? 'target' : 'nontarget';
      if (/activated (or triggered )?ability/.test(line)) d.types.push('activated ability');
      if (/(triggered ability|activated or triggered)/.test(line)) d.types.push('triggered ability');
      if (/legendary spell|or [a-z]+ spell/.test(line) && !d.types.includes('spell')) d.types.push('spell');
      // Stifle 型：どの能力でも打ち消せる（範囲は「すべて」）
      d.lock = [];
      if (d.types.includes('activated ability')) d.lock.push({ kind: 'activated', sources: ['any'], events: [] });
      if (d.types.includes('triggered ability')) d.lock.push({ kind: 'triggered', sources: ['any'], events: ['any'] });
      return d;
    }
    if (effect === 'redirect') { d.action = 'redirect'; d.types = ['spell']; d.targeting = 'target'; return d; }
    if (effect === 'discard') { d.action = /\bexile\b/.test(line) ? 'exile' : 'discard'; d.types = ['hand']; d.targeting = /\btarget\b/.test(line) ? 'target' : 'nontarget'; return d; }
    if (effect === 'gyhate') { d.action = 'exile'; d.types = ['graveyard']; d.targeting = /\btarget\b/.test(line) ? 'target' : 'nontarget'; d.scope = /\ball\b|graveyards\b|each/.test(line) ? 'all' : 'single'; return d; }

    // 処理・移動先（追放かどうかを最優先で見る）
    d.action =
      /\bexile\b/.test(line) ? 'exile' :
      /\bdestroy\b/.test(line) ? 'destroy' :
      /\bsacrifices?\b/.test(line) && /(player|opponent)s? sacrifices?/.test(line) ? 'sacrifice' :
      /gain control of/.test(line) ? 'steal' :
      /return [^.]*?to (its|their) owners?'? hands?/.test(line) ? 'bounce' :
      /on (the )?(top|bottom) of (its|their) owners?'? librar/.test(line) ? 'library' :
      /gets? -(\d+|x)\/-(\d+|x)|get -(\d+|x)\/-(\d+|x)/.test(line) ? 'minus' :
      /\bdamage\b/.test(line) ? 'damage' :
      /can't attack|doesn't untap|loses all abilities|base power and toughness/.test(line) ? 'neutralize' :
      /\bfights?\b|deals damage equal to its power/.test(line) ? 'damage' : 'other';

    // 選び方
    d.targeting = d.action === 'sacrifice' ? 'edict' : /\btarget\b/.test(line) ? 'target' : 'nontarget';
    if (effect === 'wipe') d.scope = 'all';
    else if (/up to (two|three|x|four)|(two|three|any number of) target|divided/.test(line)) d.scope = 'multi';

    // 対象の種類（影響範囲）
    const clause = (line.match(/(target|each|all|up to [\w ]+?|another target|sacrifices? (a|an|two)|that|other)\b[^.]*?(creature|artifact|enchantment|planeswalker|permanent|battle|land|spell)s?\b[^.]*/) || [line])[0];
    if (/nonland permanent/.test(clause)) d.types = ALL_PERMANENTS.filter(t => t !== 'land');
    else if (/\bpermanents?\b/.test(clause) && !/\bcreature\b|\bartifact\b|\benchantment\b/.test(clause.split(/permanent/)[0].slice(-25))) d.types = ALL_PERMANENTS.slice();
    else if (/any target/.test(line)) d.types = ['creature', 'planeswalker', 'battle', 'player'];
    else d.types = TYPE_WORDS.filter(([, re]) => re.test(clause)).map(([t]) => t);
    if (/target player or planeswalker/.test(line) && !d.types.includes('planeswalker')) d.types.push('planeswalker');
    if (!d.types.length) d.types = ['creature'];

    // 条件
    const c = line.match(/with (mana value|power|toughness) [^.,]*?(or less|or greater|less than[^.,]*|greater than[^.,]*)|\bnon(black|white|blue|red|green|artifact|land|token|legendary|creature)\b|\b(attacking|blocking|tapped|untapped) (creature|creatures)\b|\bflying\b(?= creature)|creature with flying/);
    if (c) d.cond = c[0];

    // 相手に与えるもの（Beast Within の3/3、Path to Exile の土地、Swords to Plowshares のライフ）
    const gt = line.match(/(its controller|that player|their controller|its owner|that creature's controller|that permanent's controller)( may)? (creates? [^.]*?tokens?|search(es)? [^.]*?land[^.]*|gains? life[^.]*)/);
    if (gt) d.gives = /token/.test(gt[3]) ? 'token' : /land/.test(gt[3]) ? 'land' : 'life';
    return d;
  }

  /**
   * 能力封じの範囲
   *   起動型: どのパーマネントの能力を封じるか（artifact / creature / planeswalker / nonland / named=指定したカード名 / any）
   *   誘発型: どの出来事による誘発を封じるか（etb=戦場に出る / dies=死亡）と、その対象（creature / permanent）
   */
  function lockScope(line) {
    const out = [];
    const a = line.match(/activated abilities of ([^.]*?) can't be activated/);
    if (a) {
      const src = a[1];
      const sources = /chosen name|named/.test(src) ? ['named'] :
        [['artifact', /artifacts?/], ['creature', /creatures?/], ['planeswalker', /planeswalkers?/], ['land', /\blands?\b/]]
          .filter(([, re]) => re.test(src)).map(([k]) => k);
      if (/nonland permanents?/.test(src)) sources.push('nonland');
      else if (/\bpermanents?\b/.test(src) && !sources.length) sources.push('permanent');
      out.push({ kind: 'activated', sources: sources.length ? sources : ['any'], events: [] });
    }
    const t = line.match(/(nontoken |other )?(creatures?|permanents?|artifacts?)( your opponents control)? (entering|dying)( or (entering|dying))?[^.]*? don't cause abilities to trigger/);
    if (t) {
      const events = [t[4], t[6]].filter(Boolean).map(e => e === 'entering' ? 'etb' : 'dies');
      out.push({ kind: 'triggered', sources: [/permanent/.test(t[2]) ? 'permanent' : t[2].replace(/s$/, '')], events });
    }
    return out;
  }
  const LOCK_JA = { artifact: 'アーティファクト', creature: 'クリーチャー', planeswalker: 'PW', land: '土地', nonland: '土地以外のパーマネント',
    permanent: 'パーマネント', named: '指定した名前のカード', any: 'すべて', etb: '戦場に出たとき', dies: '死亡したとき' };
  const lockLabel = l => l.kind === 'activated'
    ? `${l.sources.map(x => LOCK_JA[x] || x).join('・')}の起動型能力`
    : `${l.sources.map(x => LOCK_JA[x] || x).join('・')}が${(l.events || []).map(x => LOCK_JA[x] || x).join('・')}の誘発`;

  // ---------- 生成するトークンの種類 ----------
  const TOKEN_KINDS = ['treasure', 'clue', 'food', 'blood', 'map', 'powerstone', 'incubator', 'gold', 'shard', 'junk', 'lander', 'mutagen'];
  function tokensOf(line) {
    const out = [];
    const re = /\b(?:(that player|its controller|their controller|target opponent|each opponent|target player)\b[^.]*?)?creates? ([^.]*?)\btokens?\b/g;
    let m;
    while ((m = re.exec(line))) {
      const who = m[1] ? 'opponent' : 'self';
      const body = m[2];
      const kind = TOKEN_KINDS.find(k => new RegExp(`\\b${k}\\b`).test(body)) ||
        (/\brole\b/.test(body) ? 'role' : /\bcopy\b/.test(body) ? 'copy' : /creature|\d+\/\d+/.test(body) ? 'creature' : 'other');
      const pt = (body.match(/(\d+|x)\/(\d+|x)/) || [])[0] || null;
      out.push({ kind, pt, who });
    }
    return out;
  }

  // ---------- 速度（いつ使えるか） ----------
  function speedOf(trigger, isInstant, hasFlash, line) {
    if (trigger === 'spell' || trigger === 'cast_self') return isInstant || hasFlash ? 'instant' : 'sorcery';
    if (trigger === 'etb') return hasFlash ? 'instant' : 'sorcery';
    if (trigger === 'loyalty') return 'sorcery';
    if (trigger === 'activated' || trigger === 'activated_once') return /activate only as a sorcery|activate only during your turn/.test(line) ? 'sorcery' : 'instant';
    if (trigger === 'static') return 'static';
    return 'trigger';
  }

  const tagLabel = t => `${EFFECT_MAP[t.effect].label} × ${TRIGGERS[t.trigger].label}`;

  return { TRIGGERS, EFFECTS, EFFECT_MAP, analyze, tagLabel, detailOf, tokensOf };
});
