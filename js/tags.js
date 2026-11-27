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

  // ---------- 能力の種類（総合ルール113.3: 呪文能力・起動型能力・誘発型能力・常在型能力） ----------
  const KINDS = { spell: '呪文', activated: '起動型', triggered: '誘発型', static: '常在型' };
  // 発動条件 → 能力の種類（忠誠度能力は起動型、出たとき・章能力は誘発型）
  const kindOf = trigger => trigger === 'spell' ? 'spell'
    : ['activated', 'activated_once', 'loyalty'].includes(trigger) ? 'activated'
    : trigger === 'static' ? 'static' : 'triggered';

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
    // 上から数枚を見て1枚を手札に（トップ選択）。1枚だけ見て手札に入れるのはドロー扱い
    { id: 'topselect', label: 'トップ選択',   re: [/look at the top (two|three|four|five|six|seven|x|\d+) cards of your library[^]*?into your hand/, /reveal the top (two|three|four|five|six|seven|x|\d+) cards of your library[^]*?into your hand/, /cast [^.]*? from the top of your library/] },
    // 占術・諜報・上に戻す（トップ操作）
    { id: 'topmanip',  label: 'トップ操作',   re: [/\bscry (\d+|x)\b/, /\bsurveil (\d+|x)\b/, { test: t => /look at the top (card|\w+ cards) of your library/.test(t) && !/into your hand/.test(t) }, /put [^.]*? on top of your library/] },
    { id: 'lifegain',  label: 'ライフ回復',   re: [/\byou gain (\d+|x|that much|life equal|an amount)/, /\bgains? (\d+|x) life\b/, /\bcreate[^.]*\bfood\b/] },
    { id: 'draw',      label: 'ドロー',       re: [new RegExp(`\\bdraws? ${NUM}\\b[^.]*\\bcards?\\b`), /\binvestigate\b/, /\bclue tokens?\b/,
                                                 /exile the top [^.]*cards? of your library[\s\S]{0,120}?you may (play|cast)/,
                                                 /(look at|reveal) the top [\s\S]{0,160}?into your hand/, /top cards? of your library[\s\S]{0,80}?into your hand/, /\bconnives?\b/,
                                                 /(play lands and )?cast spells from the top of your library/, /you may (play|cast) [^.]*the top card of your library/] },
    { id: 'drain',     label: 'ダメージ/ドレイン', re: [/deals? [^.]*?damage to (each opponent|target player|target opponent|that player|each player|any target|target player or planeswalker)/,
                                                 /(each opponent|target opponent|target player|that player) loses (\d+|x) life/, /deals damage equal to [^.]*? to (target player|each opponent|any target|target opponent)/, /\beach opponent loses\b/, /(an opponent|each opponent) [^.]*?, (they|that player) loses? \d+ life/] },
    { id: 'removal',   label: '除去',         re: [/(destroy|exile) (target|another target|up to (one|two|three) (other )?target|that) (?!card)(?![^.]*\bcards? (from|in) [^.]*graveyard)(?![^.]*\byou (control|own)\b)[^.]*?(creature|artifact|enchantment|planeswalker|permanent|battle|land)/,
                                                 /deals? [^.]*?damage to (any target|(up to (one|two) )?(another )?target [^.]*?(creature|planeswalker|permanent|battle)|that (creature|permanent|planeswalker))/,
                                                 /target [^.]*?creature[^.]*? gets -(\d+|x)\/-(\d+|x)/, /\bfights? (target|another target|up to one target)/,
                                                 /target creature you control deals damage equal to its power to (another )?target/, /deals damage equal to [^.]*? to (any target|target creature|target planeswalker|up to one target)/,
                                                 /return (target|up to \w+ target) (spell or )?(nonland )?(creature|permanent|artifact|enchantment)(?![^.]*\bcards?\b)[^.]*to (its|their) owner'?s'? hand/,
                                                 /(target|each) (player|opponent) (sacrifices|exiles) (a|an|two)/, /gain control of target/, /enchanted creature can't attack\b/, /enchanted creature doesn't untap/, /put target [^.]*on (the )?(top|bottom) of its owner's library/, /return target [a-z ]*?(creature|artifact|enchantment|planeswalker|nonland permanent|permanent)s? to (its|their) owner'?s?'? hands?/, /the owner of target nonland permanent puts it into their library/, /deals \d+ damage to each of one or two targets/] },
    { id: 'wipe',      label: '全体除去',     re: [/(destroy|exile) (all|each) [^.]*?(creatures?|nonland|permanents?|artifacts?|enchantments?|lands?)\b/, /(all|each) [^.]*?creatures?[^.]*? gets? -/,
                                                 /creatures (your opponents|target player|that player) controls? gets? -/, /deals? (\d+|x) damage to each (\w+ )?(creature|other creature|creature and)/,
                                                 /damage to each opponent and each creature/, /(each|target) (player|opponent) sacrifices all\b/, /damage to [^.]*?each creature (they|your opponents) control/, /put all [^.]*creatures [^.]*on the bottom/,
                                                 /return all (nonland |creatures|permanents)[^.]*to (its|their) owners?'? hands?/] },
    { id: 'counter',   label: '打ち消し',     re: [/\bcounter target\b/, /\bexile target spell\b/, /\bcounter (it|that spell)\b/, /exile any number of target spells/, /\bcounter all\b/, /counter up to one target (activated|triggered|spell)/] },
    { id: 'redirect',  label: '対象変更',     re: [/change the targets? of target (spell|ability|spell or ability|instant)/, /choose new targets for target (spell|ability|instant)/] },
    { id: 'discard',   label: '手札破壊',     re: [/target (player|opponent) (reveals|discards)/, /(each opponent|that player|target opponent) discards/, /look at target (player|opponent)'s hand/] },
    { id: 'mana',      label: 'マナ',         re: [/\badd (\{[wubrgcs]\}|one mana|two mana|three mana|x mana|mana of any|an amount of|\{c\}\{c\})/, /\btreasure tokens?\b/,
                                                 /tapped for mana, its controller adds/, /adds? an additional/] },
    { id: 'pump',      label: '強化',         re: [/\+1\/\+1 counters?\b/, /\bgets? \+(\d+|x)\/\+(\d+|x)/, /creatures you control get \+/, /(equipped|enchanted) creature (gets|has|gains)/,
                                                 /target creature (gets|gains) [^.]*(first strike|double strike|trample|indestructible|lifelink)/, /\badapt \d+/, /\bempower [a-z]+ \d+/] },
    { id: 'energy',    label: 'エネルギー',   re: [/\bget (\{e\})+/, /\bget (x|that many|an amount of) \{e\}/] },
    { id: 'tutor',     label: 'サーチ',       re: [{ test: t => (t.match(/search your library( and graveyard)? for [^.]*?cards?[^.]*/g) || [])
                                                   .some(s => !/\b(land|forest|plains|island|swamp|mountain)\b/.test(s) || !/onto the battlefield/.test(s)) },
                                                 /from outside the game/] },
    { id: 'recursion', label: '墓地回収',     re: [/return [^.]*cards? from (your|a|any|target player's) graveyards? to (your hand|the battlefield|its owner's hand)/, /return [^.]*from your graveyard (to|onto)/,
                                                 /(cast|play) [^.]*from your graveyard/, /return enchanted creature card to the battlefield/, /creature card in a graveyard/, /choose target [^.]*?card in your graveyard\. you may cast/, /when ~? ?[a-z' ,-]* dies, if it was a creature, return it to the battlefield/, /return the exiled card to its owner's hand/] },
    { id: 'selfmill',  label: '墓地肥やし',   re: [/\bsurveil \d/, /\byou mill\b/, /\bmills? (a|one|two|three|four|\d+|x) cards?\b/] },
    { id: 'gyhate',    label: '墓地対策',     re: [/exile (all cards from )?(target player's|each opponent's|each player's|all) graveyards?/, /exile (all )?(target )?cards? from (all |a |an opponent's )?graveyards?/, /exile target card from a graveyard/,
                                                 /\btarget card in a graveyard\b/, /exile target [a-z ]*?card from a graveyard/, /would be put into an opponent's graveyard[^.]*?exile it\b/, /search its owner's graveyard[^.]*?and exile them/,
                                                 // 「墓地から〇枚まで追放」「対象のプレイヤーが自分の墓地のカードを追放する」「墓地をライブラリーの下に置く」
                                                 /exile up to (one|two|three|four|x|\d+) target cards? from (a single graveyard|graveyards|a graveyard|any graveyards?|target player's graveyard)/,
                                                 /(target|each) (player|opponent) exiles [^.]*?from (their|his or her) graveyard/,
                                                 /puts? all (the )?cards from (their|his or her|target player's|each opponent's) graveyards? on the bottom of/,
                                                 // 実データで見つかった書き方（Thraben Charm、Kaya's Guile、Strategic Betrayal、Go Blank、Crypt Incursion、Sanctifier en-Vec など）
                                                 /exile (any number of )?(all )?(target players'|all opponents'|each opponent's|opponents'|that player's|its controller's) graveyards?/,
                                                 /exiles? [^.]*? and (their|his or her) graveyard/,
                                                 /exile all [a-z ]*?cards? (that are [^.]*? )?from (all graveyards|target player's graveyard|each opponent's graveyard|all opponents' graveyards|a graveyard)/,
                                                 /creature cards from graveyards/, /from that player's graveyard or hand and exile it/,
                                                 /search (target opponent's|its controller's|its owner's|target player's) graveyard[^.]*?exile them/] },
    { id: 'hate',      label: '妨害（ロック）', re: [/\bcosts? \{\d\} more\b/, /would cost less than \w+ mana to cast costs/, /\bcost \{\d\} more\b/, /nonbasic lands (are|don't untap)/, /\bcan't cast (spells|noncreature|creature|instant|sorcery)/,
                                                 /can't be activated/, /(each player|players|your opponents|target player) can't (cast|activate|search|gain life|draw)/, /don't cause abilities to trigger/,
                                                 /(lands|creatures|artifacts|permanents) (your opponents control )?enter (the battlefield )?tapped/, /\bdon't untap during/, /players skip/, /tap for more than one mana produce/, /can't untap more than/,
                                                 /tapped for two or more mana/, /lands your opponents control[^.]*?lose all land types/, /(enchanted|target)( nonbasic)? land (is|becomes) an? /, /can cast spells only any time they could cast a sorcery/, /can't draw more than one card each turn/, /creatures lose all abilities/, /destroy this creature unless you pay/] },
    // 攻撃の制限（Ensnaring Bridge、Propaganda、Moat、Peacekeeper など）
    { id: 'attacklock', label: '攻撃制限',    re: [/\bcreatures (with [^.]*?|without [^.]*?|your opponents control )?can't attack\b/, /no more than (one|two) creatures? can attack/] },
    { id: 'cheat',     label: '踏み倒し',     re: [/put (a|an|up to \w+|any number of|that|those|target)\b[^.]*?\b(creature|artifact|enchantment|permanent|planeswalker|nonland)\b[^.]*?\bcards?\b[^.]*?onto the battlefield/,
                                                 /(artifact|creature|enchantment|planeswalker|permanent)( cards?|, (artifact|creature|enchantment|planeswalker|land)[\w, ]*? cards?) from (their|your) hand onto the battlefield/, { test: t => /puts? that (creature )?card onto the battlefield/.test(t) && /\bcreature card\b/.test(t) && !/\bland card\b/.test(t) }, { test: t => t.split(/(?<=\.)\s+/).some(x => /(?<!(this spell|cast it|cast this card) )without paying (its|their) mana costs?/.test(x) && !/from (your|a) graveyard/.test(x)) }] },
    { id: 'extraturn', label: '追加ターン',   re: [/take an extra turn/] },
    { id: 'untap',     label: 'アンタップ',   re: [/\buntap (target|all|up to \w+ target|another target|up to \w+) (artifacts?|lands?|nonland permanents?)\b/, /\buntap (this artifact|another target permanent|target permanent|target creature)\b/, /^(\{[^}]+\})+: untap (this|~|[a-z' ,-]+)\.$/] },
    { id: 'copy',      label: 'コピー/ストーム', re: [/(^|, )storm\b(?!-)/, /copy (target|that|the exiled|it)[^.]*?(instant|sorcery|spell|card)/] },
    { id: 'protection', label: '保護',        re: [/(gains?|have|has) (hexproof|indestructible|shroud|protection from)/, /phases? out/, /\bregenerate\b/,
                                                 /exile [^.]*?(target|any number of target) [^.]*?(creature|permanent|nonland)[^.]*?(you control|you own)[\s\S]{0,60}?return (it|that card|them|those cards)/, /return one or two target creatures and\/or enchantments you own to your hand/] },
    // ---- 以下は表示・集計用のタグ（役割にはつながないものが多い）----
    { id: 'landetb',    label: '土地の出方',   re: [/\benters tapped\b/, /as (this land|~) enters, you may pay \d+ life/, /(this land|~) is the chosen type/, /each land is an? [a-z]+ in addition to its other land types/, /return a land you control to its owner's hand/, /lands you control enter untapped/, /lands you control are every basic land type/, /(this land|~) is every nonbasic land type/, /enter tapped as a copy of any land/, /this land becomes a copy of target (land|permanent card)/] },
    { id: 'landsearch', label: '土地サーチ',   re: [/search your library for [^.]*?\b(land|plains|island|swamp|mountain|forest)\b cards?/] },
    { id: 'extraland',  label: '追加の土地',   re: [/you may play (an )?additional lands?/, /put (a|up to \w+) land cards? from your hand onto the battlefield/] },
    { id: 'evasion',    label: '回避能力',     re: [/can't be blocked/, /\b(gains?|has|have) (flying|menace|trample|shadow)\b/] },
    { id: 'combatkw',   label: '戦闘能力',     re: [/\b(gains?|has|have) (first strike|double strike|deathtouch|vigilance|reach)\b/] },
    { id: 'flash',      label: '瞬速',         re: [/as though (it|they) had flash/, /\b(gains?|has|have) flash\b/] },
    { id: 'resilience', label: '耐性',         re: [/can't be countered/, /\bward\b/] },
    { id: 'altcost',    label: '代替コスト',   re: [/rather than pay (this spell's|its) mana cost/, /without paying (its|their) mana costs?/] },
    { id: 'costreduce', label: 'コスト軽減',   re: [/(this spell|~) costs? \{[\dx]+\} less to cast/, /\bcosts? \{\d+\} less to activate/, /spells? you cast[^.]*? costs? \{\d+\} less to cast/, /spells? [^.]*?you cast during [^.]*? costs? \{\d+\} less/, /you can't spend mana to cast this spell/] },
    { id: 'addcost',    label: '追加コスト',   re: [/as an additional cost to cast this spell/] },
    { id: 'equip',      label: '装備・つける', re: [/^enchant (creature|permanent|land|artifact|player|planeswalker|forest|plains|island|swamp|mountain|nonland permanent)/, /attach (it|~|this)/] },
    { id: 'drawback',   label: 'デメリット',   re: [/doesn't untap during your untap step/, /deals? \d+ damage to you\b/, /you lose \d+ life for each/, /(this creature|~) can't block\b/, /\bskip your draw step/, /when you play another land, sacrifice/, /can't attack or block unless/, /if you don't, you lose the game/, /return (a|an) (permanent|artifact|land|creature) you control to its owner's hand/, /at the beginning of the end step, sacrifice (this|~)/, /can block only creatures with flying/] },
    { id: 'setup',      label: '準備',         re: [/as (this|~) [a-z ]*?enters, choose/, /when (this|~) [a-z ]*?enters, choose/, /in your opening hand/, /enters with [^.]*counters? on it/, /enters prepared/, /you may exile [^.]*? from your hand/, /^to solve —/, /if this artifact would enter, you may discard/] },
    { id: 'transform',  label: '変身',         re: [/\btransformed\b/, /\btransform (it|~|this)/] },
    { id: 'monarch',    label: '統治者・イニシアチブ', re: [/become the monarch/, /take the initiative/] },
    { id: 'statdef',    label: 'P/Tの定義',    re: [/(power|toughness) (is|are) (each )?equal to/, /gets \+\d+\/\+\d+ for each/] },
    { id: 'animate',    label: 'クリーチャー化', re: [/becomes an? (\d+\/\d+ )?[^.]*?\bcreature\b/, /\bearthbend \d+/] },
    { id: 'level',      label: 'レベルアップ', re: [/:\s*level \d/, /\blevel up\b/] },
    { id: 'haste',      label: '速攻',         re: [/\b(gains?|has|have) haste\b/, /as though (those creatures|they|it) had haste/] },
    { id: 'cycling',    label: 'サイクリング', re: [] },
    { id: 'tapdown',    label: 'タップ・拘束', re: [/\btap (target|up to (one|two|three) target) (creature|permanent|artifact|land)/, /stun counters? on/, /tap or untap target/] },
    { id: 'bonus',      label: '条件付きの強化', re: [/— ~ deals \d+ damage instead/, /instead if (there are|you control)/, /would die this turn, exile it instead/] },
    { id: 'charkw',     label: '特性',         re: [] },
    { id: 'misc',       label: 'その他（未分類）', re: [] }
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
  // 裏面を手札から唱えられないレイアウト（変身・合体・反転）。裏面の能力は別扱いにする
  const NONPLAY_LAYOUTS = new Set(['transform', 'meld', 'flip']);
  // プレインズウォーカーの「奥義」: 出たターンには起動できない忠誠度能力（マイナスの値が初期忠誠度より大きい）
  const isUltimate = (raw, loyalty) => {
    const m = String(raw).trim().match(/^[−-](\d+):/);
    return !!m && loyalty != null && +m[1] > loyalty;
  };
  function faces(card) {
    const types = String(card.typeLine || '').split(' // ');
    const texts = String(card.oracle || '').split(/\n\/\/\n/);
    const loyalty = parseInt(card.loyalty, 10);
    return texts.map((text, i) => {
      const type = types[i] || types[0] || '';
      const pw = i === 0 && /\bPlaneswalker\b/.test(type) && !isNaN(loyalty);
      const lines = text.split('\n');
      return {
        type, playable: i === 0 || !NONPLAY_LAYOUTS.has(card.layout),
        text: pw ? lines.filter(l => !isUltimate(l, loyalty)).join('\n') : text,
        ult: pw ? lines.filter(l => isUltimate(l, loyalty)) : []
      };
    });
  }
  /** 奥義（出たターンに起動できない忠誠度能力）だけのテキスト（なければ null） */
  function ultimateFace(card) {
    if (!card) return null;
    const f = faces(card)[0];
    return f && f.ult.length ? { typeLine: f.type, oracle: f.ult.join('\n') } : null;
  }
  /** 手札から使える面だけのテキスト */
  function playableOracle(card) {
    return faces(card).filter(f => f.playable).map(f => f.text).join('\n//\n');
  }
  /** 手札から唱えられない裏面（なければ null） */
  function backFace(card) {
    if (!card || !NONPLAY_LAYOUTS.has(card.layout)) return null;
    const f = faces(card).slice(1);
    if (!f.length) return null;
    return { typeLine: f.map(x => x.type).join(' // '), oracle: f.map(x => x.text).join('\n//\n') };
  }

  // ---------- キーワード能力だけの行（「飛行、速攻」「装備 {1}」「サイクリング {2}」など） ----------
  // [パターン, 効果, 発動条件]。発動条件はキーワード能力の種類（常在型・起動型・誘発型）に合わせる
  const KEYWORDS = [
    [/^(flying|menace|trample|shadow|horsemanship|fear|intimidate|skulk|[a-z]+walk)$/, 'evasion', 'static'],
    [/^haste$/, 'haste', 'static'],
    [/^(first strike|double strike|deathtouch|vigilance|reach)$/, 'combatkw', 'static'],
    [/^lifelink$/, 'lifegain', 'static'],
    [/^(defender|vanishing \d+|fading \d+|echo\b.*|cumulative upkeep\b.*)$/, 'drawback', 'static'],
    [/^(indestructible|hexproof|hexproof from .+|shroud|protection from .+|ward\b.*|split second)$/, 'resilience', 'static'],
    [/^flash$/, 'flash', 'static'],
    [/^prowess$/, 'pump', 'cast_trigger'],
    [/^([a-z]+)?cycling\b.*$/, 'cycling', 'activated_once'],
    [/^(equip|reconfigure|crew)\b.*$/, 'equip', 'activated'],
    [/^(evoke|dash|ninjutsu|plot|warp|bestow|impending|spectacle|prowl|surge|emerge|blitz|overload|madness|foretell|miracle|suspend|morph|megamorph|disguise|mutate|sneak)\b.*$/, 'altcost', 'static'],
    [/^(affinity for .+|delve|improvise|convoke|undaunted|assist)$/, 'costreduce', 'static'],
    [/^(kicker|multikicker|bargain|spree|replicate|entwine|buyback|casualty|offspring|gift\b.*|squad|escalate|strive)\b.*$/, 'addcost', 'static'],
    [/^cascade$/, 'cheat', 'cast_self'],
    [/^(devoid|changeling)$/, 'charkw', 'static'],
    [/^mobilize \d+$/, 'token', 'attack'],
    [/^(dredge \d+|rebound|flashback\b.*|unearth\b.*|escape\b.*|disturb\b.*|embalm\b.*|eternalize\b.*|retrace|jump-start|harmonize\b.*)$/, 'recursion', 'static'],
    [/^storm$/, 'copy', 'cast_self'],
    [/^(ascend|level up\b.*|sunburst|teamwork \d+|learn)$/, 'setup', 'static'],
    [/^(splice onto [a-z]+\b.*|transmute\b.*)$/, 'altcost', 'static'],
    [/^(annihilator \d+)$/, 'combatkw', 'attack'],
    [/^(living weapon|for mirrodin!)$/, 'equip', 'etb']
  ];
  function keywordLine(line) {
    const body = line.replace(/\.$/, '');
    // コストに読点が入る書き方（「授与—{r}、証拠収集6」）は1つのキーワードとして扱う
    const parts = /^[a-z -]+(—|\s\{)/.test(body) ? [body] : body.split(/,\s*/);
    const out = [];
    for (const part of parts) {
      const hit = KEYWORDS.find(([re]) => re.test(part.trim()));
      if (!hit) return null;
      out.push(hit);
      // 土地サイクリング（「島サイクリング」など）は土地サーチでもある
      const m = part.trim().match(/^([a-z]+)cycling\b/);
      if (m && m[1]) out.push([null, 'landsearch', 'activated_once']);
    }
    return out;
  }
  // 能力ではない構造の行（モード選択の見出し）
  const STRUCTURAL = /(^|, )choose (one|two|three|four|any number|one or both|one or more|up to [a-z]+)\b[^.]*—$|^choose one\. if you control/;

  function analyze(card) {
    if (!card) return { abilities: [], tags: [], tokens: [], evasion: false, power: null, speed: 'sorcery' };
    const abilities = [], untagged = [];
    faces(card).filter(f => f.playable).forEach(({ type, text: faceText }) => {
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
        // エルドラージの落とし子・末裔だけを作るならマナ（生け贄でマナを出すためのトークン）
        if (effects.includes('token') && /eldrazi (spawn|scion) creature tokens?/.test(line) && !/\d+\/\d+ (?!colorless eldrazi)[^.]*creature token/.test(line.replace(/0\/1 colorless eldrazi spawn|1\/1 colorless eldrazi scion/g, ''))) {
          effects.splice(effects.indexOf('token'), 1);
          if (!effects.includes('mana')) effects.push('mana');
        }
        // 絆魂はライフゲイン
        if (/(^|, )lifelink($|,)/.test(line) && !effects.includes('lifegain')) effects.push('lifegain');
        // 「墓地のカードを全て追放」は全体除去ではなく墓地対策（Crypt Incursion）
        if (effects.includes('wipe') && /exile all [^.]*?cards? (that are [^.]*? )?from [^.]*?graveyards?/.test(line) && !/(creatures?|permanents?) (you|they|your opponents) control/.test(line)) {
          effects.splice(effects.indexOf('wipe'), 1);
          if (!effects.includes('gyhate')) effects.push('gyhate');
        }
        // 「対象のプレイヤーが自分の墓地のカードを追放する」は除去ではなく墓地対策（Relic of Progenitus）
        if (effects.includes('removal') && /(player|opponent) exiles [^.]*?from (their|his or her) graveyard/.test(line) && !/(creature|permanent|artifact|enchantment|planeswalker) (they|that player) control/.test(line)) {
          effects.splice(effects.indexOf('removal'), 1);
          if (!effects.includes('gyhate')) effects.push('gyhate');
        }
        // 「カードを引くたび」は誘発条件で、効果ではない（Sheoldred, the Apocalypse）
        if (effects.includes('draw') && /^(when|whenever) [^,]*\bdraws? (a|your)\b[^,]*,/.test(line) && !/\bdraws? (a|one|two|three|\w+) cards?\b/.test(line.replace(/^[^,]*,/, ''))) effects.splice(effects.indexOf('draw'), 1);
        // 相手の土地にマナ能力を与えるだけの文（Alpine Moon）は、自分のマナにはならない
        if (effects.includes('mana') && /lands your opponents control/.test(line)) effects.splice(effects.indexOf('mana'), 1);
        // 全体除去だけの能力は単体除去から外す
        if (effects.includes('wipe') && effects.includes('removal') && !/\btarget\b/.test(line)) effects.splice(effects.indexOf('removal'), 1);
        if (RECURSION_KEYWORDS.test(line) && !effects.includes('recursion')) effects.push('recursion');
        const tokens = tokensOf(line);
        if (effects.length || tokens.length) abilities.push({ text: line, triggers, effects, tokens, isInstant: /\bInstant\b/.test(type) });
        else if (STRUCTURAL.test(line)) continue;
        else {
          const kws = keywordLine(line);
          if (kws) {
            // キーワード能力は種類ごとに発動条件を分けて1つずつ能力にする
            for (const [, eff, trig] of kws) abilities.push({ text: line, triggers: [trig], effects: [eff], tokens: [], isInstant: /\bInstant\b/.test(type) });
          } else {
            // どれにも当てはまらない文は「その他（未分類）」として残す（タグ化の取りこぼし確認用に untagged にも記録）
            abilities.push({ text: line, triggers, effects: ['misc'], tokens: [], isInstant: /\bInstant\b/.test(type) });
            untagged.push({ text: line, kind: kindOf(triggers[0]) });
          }
        }
      }
    });
    const kw = (card.keywords || []).join(' ').toLowerCase();
    const hasFlash = /\bflash\b/.test(kw) || /^flash$/m.test(clean(playableOracle(card)));
    const seen = new Set();
    const tags = [];
    for (const a of abilities) for (const t of a.triggers) for (const e of a.effects) {
      const detail = DISRUPT_EFFECTS.has(e) ? detailOf(a.text, e) : null;
      // 妨害は処理と対象の種類が違えば別のタグとして残す（Kolaghan's Command の「破壊」と「ダメージ」など）
      const k = e + '@' + t + (detail ? `#${detail.action}:${detail.types.join(',')}` : '');
      if (seen.has(k)) continue;
      seen.add(k);
      const tag = { effect: e, trigger: t, kind: kindOf(t), repeat: TRIGGERS[t].repeat, speed: speedOf(t, a.isInstant, hasFlash, a.text) };
      if (detail) tag.detail = detail;
      tags.push(tag);
    }
    const tokens = abilities.flatMap(a => a.tokens || []);
    const evasion = EVASION.test(kw) || /can't be blocked/.test(clean(playableOracle(card)));
    // カード全体の速度：インスタント・瞬速、またはマナ以外の起動型能力があればインスタント速度で動ける
    const front = String(card.typeLine || '').split(' // ')[0];
    const speed = /\bInstant\b/.test(front) || hasFlash ? 'instant' :
      abilities.some(a => a.triggers.includes('activated') && !/activate only as a sorcery/.test(a.text) && !(a.effects.length === 1 && a.effects[0] === 'mana')) ? 'instant' : 'sorcery';
    return { abilities, tags, tokens, evasion, power: card.power, speed, untagged };
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
      if (/can't cast|can't be cast|can cast spells only any time they could cast a sorcery/.test(line)) t.push('spell');
      if (/from graveyards|in graveyards/.test(line)) t.push('graveyard');
      if (/costs? \{\d\} more|cost \{\d\} more|would cost less than/.test(line)) t.push('tax');
      if (/nonbasic lands|tap for more than one mana|produce \{c\}|tapped for two or more mana|lose all land types|(enchanted|target)( nonbasic)? land (is|becomes) an? /.test(line)) t.push('mana');
      if (/can't search/.test(line)) t.push('library');
      if (/can't attack|can attack/.test(line)) t.push('attack');
      // 「タップ状態で出る」「アンタップしない」：土地ならマナ、クリーチャーなら戦闘への妨害
      // 自分のパーマネントにかかるデメリット（Bontu's Last Reckoning など）は除く
      if (/don't untap|doesn't untap|can't untap more than|enter (the battlefield )?tapped/.test(line) && !/\byou control (don't|doesn't|enter)\b/.test(line)) {
        if (/\blands?\b/.test(line)) t.push('mana');
        if (/\bcreatures?\b|\bpermanents?\b/.test(line)) t.push('untap');
      }
      if (/can't (gain life|draw)|can't draw more than/.test(line)) t.push('other');
      if (/creatures lose all abilities/.test(line)) t.push('activated ability', 'triggered ability');
      d.types = t.length ? t : ['none'];   // none: 自分へのデメリットなど、相手への妨害ではないもの
      d.lock = lockScope(line);
      if (d.lock.length) d.cond = d.lock.map(lockLabel).join('、');
      return d;
    }
    // 置物型の条件付き打ち消し（Chalice of the Void、Void Mirror、Vexing Bauble など）
    if (effect === 'counter' && /whenever (a player|an opponent) casts (a|an) [^,]*?spell[^.]*?counter that spell/.test(line)) {
      d.action = 'counter'; d.targeting = 'nontarget'; d.scope = 'all'; d.types = ['spell']; d.lock = [];
      d.counterCond = /mana value equal to the number of charge counters|mana value equal to/.test(line) ? 'mv'
        : /no colored mana was spent/.test(line) ? 'colorless'
        : /no mana was spent/.test(line) ? 'free' : 'other';
      d.cond = { mv: 'マナ総量が指定の値の呪文', colorless: '色マナを使わずに唱えた呪文', free: 'マナを使わずに唱えた呪文', other: '条件を満たした呪文' }[d.counterCond];
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
      /return [^.]*?to (its|their) owner'?s'? hands?/.test(line) ? 'bounce' :
      /on (the )?(top|bottom) of (its|their) owners?'? librar/.test(line) ? 'library' :
      /gets? -(\d+|x)\/-(\d+|x)|get -(\d+|x)\/-(\d+|x)/.test(line) ? 'minus' :
      /\bdamage\b/.test(line) ? 'damage' :
      /can't attack|doesn't untap|loses all abilities|base power and toughness/.test(line) ? 'neutralize' :
      /\bfights?\b|deals damage equal to its power/.test(line) ? 'damage' : 'other';

    // 選び方
    d.targeting = d.action === 'sacrifice' ? 'edict' : /\btarget\b/.test(line) ? 'target' : 'nontarget';
    if (effect === 'wipe') d.scope = 'all';
    else if (/up to (two|three|x|four)|(two|three|any number of) target|divided/.test(line)) d.scope = 'multi';

    // 対象の種類（影響範囲）：最初の「target / each / all ...」のすぐ後ろの名詞だけを見る
    //   （後ろの文の "a permanent you controlled left the battlefield" などを巻き込まないため）
    const TYPE_NOUN = '(?:creature|artifact|enchantment|planeswalker|permanent|battle|land|spell)s?';
    const np = line.match(new RegExp(`\\b(target|each|all|another target|that|up to (?:one|two|three|x)(?: other)? target|sacrifices? (?:a|an|two|all))\\b((?: (?!(?:you|an opponent|your opponents|their|its)\\b)[a-z'-]+,?){0,4}? ${TYPE_NOUN}(?:(?:,| or| and|, or|, and) (?:non[a-z]+ )?${TYPE_NOUN})*)`));
    const nouns = np ? np[2] : line;
    if (/any target/.test(line)) d.types = ['creature', 'planeswalker', 'battle', 'player'];
    // 土地を含まない指定（nonland、色の指定、「if it's blue」など）
    else if (/\bnonland\b|\b(colored|multicolored|monocolored|white|blue|black|red|green) permanents?|(that's|that are) one or more colors|if it's (white|blue|black|red|green)/.test(nouns + ' ' + (np ? line.slice(line.indexOf(np[0]), line.indexOf(np[0]) + np[0].length + 60) : ''))) d.types = ALL_PERMANENTS.filter(t => t !== 'land');
    else if (/\bpermanents?\b/.test(nouns)) d.types = ALL_PERMANENTS.slice();
    else d.types = TYPE_WORDS.filter(([, re]) => re.test(nouns)).map(([t]) => t);
    if (/target player or planeswalker/.test(line) && !d.types.includes('planeswalker')) d.types.push('planeswalker');
    if (/\bspells?\b/.test(nouns) && !d.types.includes('spell')) d.types.push('spell');   // Divide by Zero のように呪文も戻せるもの
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

  return { TRIGGERS, KINDS, kindOf, EFFECTS, EFFECT_MAP, analyze, tagLabel, detailOf, tokensOf, playableOracle, backFace, ultimateFace };
});
