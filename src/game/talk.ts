// Conversations: the generic *.TLK dialogue (1000:A4B4), Lord British (1000:E59B), joining (1000:A2BD),
// giving to beggars (1000:A3A2), the yes/no question (1000:A163), and the vendor dispatch for NPCs
// reached across a shop counter (1000:A6F3 -> 1000:A686).
import type { Game } from "./game";
import { rand8 } from "./rng";
import type { Npc, TownMap } from "./maps";
import { T } from "./tiles";
import { JOIN_RULES } from "../data/tables";
import { LB, TALK } from "./town/strings";
import { MSG_TOWN } from "./texts/town";
import { answerLetter, askYN, nl, pause, putc, putNum, readLine, readNumber, say, sayRaw, strnieq, waitKey } from "./prompts";
import { runShop } from "./shops";
import { karmaDec, karmaInc, markVirtue, virtueReady, Virtue } from "./karma";
import { TOPICS, type ConversationTurn } from "./conversation/provider";
import { conversationProvider } from "./conversation/llm";
import { playEffect, SFX } from "../audio/speaker";
import { inverted, VIEWPORT_RECT } from "../ui/invert";

const base = (tile: number) => tile & ~1;

/**
 * Called by Game when the player Talks. `counter`: the counter square when talking across one
 * (tiles 0x60..0x7E); only a merchant (tile 0x52) answers there, with the shop of that counter row.
 */
export async function talkTo(g: Game, npc: Npc, counter: { x: number; y: number } | null = null) {
  if (counter) {
    if (base(npc.tile) === T.CITIZEN) await runShop(g, counter.y);
    else await say(g, TALK.funny);
    return;
  }
  if (!npc.talk || !npc.dialogue) { await say(g, TALK.funny); return; }
  if (base(npc.tile) === T.LORD_BRITISH) { await lordBritish(g); return; }
  await converse(g, npc);
}

// ---------------------------------------------------------------- generic conversation

/** 1000:A4B4 */
async function converse(g: Game, npc: Npc) {
  const d = npc.dialogue!;
  // 1000:A443: the description starts lower case
  const look = d.look && d.look[0] >= "A" && d.look[0] <= "Z" ? d.look[0].toLowerCase() + d.look.slice(1) : d.look;
  const members = g.save.members;

  const text = async (s: string) => { if (s) { await say(g, s); nl(g); } }; // 1000:A22D
  // handlers of the keyword table DS:0x2A90, in TOPICS order (the two TLK keywords are entries 5 and 6);
  // which entry an input selects is decided by the conversation provider (keyword matching by default)
  const table: (() => Promise<void>)[] = [
    async () => {},
    async () => { await say(g, d.pronoun, TALK.saysIAm, d.name); nl(g); },
    async () => { await say(g, TALK.youSee); await text(look); },
    () => text(d.job),
    () => text(d.health),
    () => text(d.response1),
    () => text(d.response2),
    () => join(g, npc),
    () => give(g, npc),
  ];
  const provider = conversationProvider();
  const profile = { dialogue: d, place: (g.map as TownMap).loc.name, tile: npc.tile };
  const history: ConversationTurn[] = [];

  await say(g, TALK.youMeet);
  await text(look);
  if (rand8() & 1) {
    nl(g);
    await say(g, d.pronoun, TALK.saysIAm2, d.name);
    nl(g);
  }
  let done = false;
  do {
    await say(g, TALK.yourInterest);
    const q = await readLine(g, 11);
    nl(g);
    if (!q) break;
    // turning away, or attacking when the roll is far below the TLK probability
    const r = rand8();
    if (r < d.turnAwayProb) {
      if (d.turnAwayProb - r > 0x3f) {
        const a = MSG_TOWN.articleA, the = MSG_TOWN.articleThe; // DS:0x2C7E, DS:0x2C81
        // other languages add their own articles ("un ", "l'"...) for translated names
        const articles = [a, the, ...MSG_TOWN.moreArticles];
        const who = articles.some((x) => x && strnieq(d.name, x, x.length)) ? d.pronoun : d.name;
        await say(g, who, TALK.onGuard);
        npc.movement = 0xff;
        npc.hostile = true;
        return;
      }
      await say(g, d.pronoun, TALK.turnsAway);
      return;
    }
    const reply = await provider.answer(profile, q, history);
    history.push({ input: q, topic: reply.topic, text: reply.text ?? "" });
    const i = reply.topic ? TOPICS.indexOf(reply.topic) : -1;
    if (i === 0) done = true; // bye
    else if (i > 0) {
      await table[i]();
      if (members !== g.save.members) return; // joined the party
      if (d.questionTrigger === i) await question(g, d);
    } else if (reply.text) { await say(g, reply.text); nl(g); }
    else await say(g, TALK.cannotHelp);
  } while (!done);
  await say(g, TALK.bye);
}

/** 1000:A163: the NPC's yes/no question; a humility question changes Humility. */
async function question(g: Game, d: NonNullable<Npc["dialogue"]>) {
  nl(g);
  await waitKey(g);
  await say(g, d.question);
  await say(g, TALK.youSay);
  let c = "";
  for (;;) {
    const a = await readLine(g, 4);
    nl(g);
    if (!a) break;
    c = answerLetter(a[0]);
    if (c === "N" || c === "Y") break;
    await say(g, TALK.yesOrNo);
  }
  if (!c || (c !== "N" && c !== "Y")) return;
  if (c === "Y") {
    if (d.humilityTest) await karmaDec(g, Virtue.Humility, 5);
    await say(g, d.yes);
  } else {
    if (d.humilityTest && virtueReady(g)) karmaInc(g, Virtue.Humility, 10);
    await say(g, d.no);
  }
  markVirtue(g);
  nl(g);
}

/** 1000:A2BD: the companion of a virtue town (dialogue 1 of towns 5..12) may join. */
async function join(g: Game, npc: Npc) {
  const s = g.save, town = (g.map as TownMap).loc.id, v = town - 5;
  if (npc.talk === 1 && v >= 0 && v < 8 && s.players[0].klass !== v) {
    const k = s.karma[v];
    if (k > 0 && k < JOIN_RULES.minKarma) {
      await say(g, TALK.notAdj, TALK.adjectives[v], TALK.adjEnough);
    } else if (s.members * JOIN_RULES.hpPerMember + JOIN_RULES.hpBase <= s.players[0].hpMax) {
      await say(g, TALK.honoredJoin);
      const map = g.map as TownMap;
      map.npcs = map.npcs.filter((n) => n !== npc); // the original clears NPC slot 31
      // PARTY.SAV keeps one record per class: swap the companion's record into the next slot
      let i = 7;
      while (i >= 0 && s.players[i].klass !== v) i--;
      if (i >= 0) [s.players[i], s.players[s.members]] = [s.players[s.members], s.players[i]];
      s.members++;
    } else await say(g, TALK.notExperienced);
  } else await say(g, npc.dialogue!.pronoun, TALK.cannotJoin);
}

/** 1000:A3A2: only beggars (tile 0x58) take gold; Compassion +2 at most once per 16 moves. */
async function give(g: Game, npc: Npc) {
  const s = g.save, d = npc.dialogue!;
  if (base(npc.tile) !== T.BEGGAR) { await say(g, d.pronoun, TALK.notNeedGold); return; }
  await say(g, TALK.howMuch);
  const n = await readNumber(g, 2);
  if (n <= 0) return;
  if (s.gold < n) { await say(g, TALK.notThatMuchGold); return; }
  s.gold -= n;
  await say(g, d.pronoun, TALK.thankKindness);
  if (virtueReady(g)) karmaInc(g, Virtue.Compassion, 2);
  markVirtue(g);
}

// ---------------------------------------------------------------- Lord British

/** 1000:E59B */
async function lordBritish(g: Game) {
  const s = g.save, me = s.players[0].name;
  if (!s.lbIntro) {
    s.lbIntro = 1;
    await say(g, LB.rises, me);
    putc(g, ",");
    await say(g, LB.haveCome);
    await pause(g);
    await say(g, LB.sits);
    await lbAsk(g, LB.howHelp);
    return;
  }
  if (s.players[0].status === "D") {
    s.players[0].status = "G";
    await say(g, me, LB.liveAgain);
    // noise bursts, then the magic sound between two viewport inverts (1000:E600, 1000:2241)
    await playEffect(SFX.CAST, 0x14);
    await inverted(g, [VIEWPORT_RECT], () => playEffect(SFX.MAGIC, 0xc0));
    healAll(g);
  }
  await say(g, LB.welcome, me);
  if (s.members >= 3) await say(g, LB.adventurers);
  else if (s.members === 2) await say(g, LB.also, s.players[1].name, LB.excl2);
  else nl(g);
  await levelUp(g);
  await lbAsk(g, null);
}

/** Lord British's question loop (keywords DS:0x6FF0 matched on 4 characters, answers DS:0x7022). */
async function lbAsk(g: Game, prompt: string | null) {
  for (;;) {
    if (prompt) await say(g, prompt);
    const q = await readLine(g, 15);
    nl(g);
    let k = 0;
    if (q) {
      k = LB.keywords.findIndex((w) => strnieq(q, w, 4));
    }
    if (k === 0) break;
    if (k === -1) await say(g, LB.cannot);
    else if (k === 1) await lbHelp(g);
    else if (k === 2) await lbHealth(g);
    else await sayRaw(g, LB.answers[k - 3]);
    prompt = LB.whatElse;
  }
  await say(g, LB.fare);
  if (g.save.members > 1) putc(g, "s");
  await say(g, LB.excl);
}

/** 1000:E408: every member not dead is healed and cured. */
function healAll(g: Game) {
  for (const p of g.members) if (p.status !== "D") { p.status = "G"; p.hp = p.hpMax; }
}

/** 1000:E442 "health" */
async function lbHealth(g: Game) {
  await say(g, LB.health);
  const c = await askYN(g);
  if (c === "Y") await say(g, LB.good);
  else if (c === "N") {
    await say(g, LB.heal);
    await playEffect(SFX.CAST, 10); // 1000:E474
    await inverted(g, [VIEWPORT_RECT], () => playEffect(SFX.MAGIC, 0xc0)); // between two viewport inverts (1000:2241)
    healAll(g);
  }
}

/** 1000:E4C3: level = 1 + number of doublings of 100 reached by XP; raises max HP and stats. */
async function levelUp(g: Game) {
  for (const p of g.members) {
    let target = 100;
    for (let t = 100; t <= p.xp; t = (t << 1) & 0xffff) { target += 100; if (!t) break; }
    if (p.hpMax < target) {
      p.hpMax = p.hp = target;
      p.status = "G";
      // 1000:E498: +1..8, capped at 50
      p.str = Math.min(50, p.str + (rand8() & 7) + 1);
      p.dex = Math.min(50, p.dex + (rand8() & 7) + 1);
      p.int = Math.min(50, p.int + (rand8() & 7) + 1);
      nl(g);
      await say(g, p.name, LB.level);
      putNum(g, Math.floor(target / 100));
      nl(g);
      await inverted(g, [VIEWPORT_RECT], () => playEffect(SFX.MAGIC, 0xc0)); // between two viewport inverts (1000:E575, 1000:2241)
    }
  }
  await say(g, LB.ask);
}

/** 1000:E21E "help": advice according to the progress of the quest. */
async function lbHelp(g: Game) {
  const s = g.save, k = s.karma;
  const parts = async (...t: string[]) => {
    for (let i = 0; i < t.length; i++) { await say(g, t[i]); if (i < t.length - 1) await pause(g); }
  };
  await say(g, LB.heSays);
  if (s.moves < 1000) await parts(LB.help0a, LB.help0b, LB.help0c);
  else if (s.members === 1) await parts(LB.help1a, LB.help1b);
  else if (s.runes === 0) await parts(LB.help2a, LB.help2b, LB.help2c, LB.help2d);
  else if ((k[7] & k[0] & k[1] & k[2] & k[3] & k[4] & k[5] & k[6]) !== 0) await parts(LB.help3a, LB.help3b, LB.help3c);
  else if (s.stones === 0) await parts(LB.help4, LB.help4b);
  else if (k.every((v) => v === 0)) {
    const it = s.items;
    if (((it >> 4) & (it >> 3) & (it >> 2) & 1) === 0) await parts(LB.help6);
    else if (((it >> 5) & (it >> 6) & (it >> 7) & 1) === 0) await parts(LB.help7a, LB.help7b);
    else await parts(LB.help8a, LB.help8b, LB.help8c);
  } else await parts(LB.help5);
}

