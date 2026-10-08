# Ultima IV (DOS/GOG) reverse-engineering notes

Companion to `src/data/tables.ts`. Everything was extracted from `AVATAR.EXE` of the GOG release.

## Binary layout / how to reproduce
- `AVATAR.EXE` is **EXEPACKed**. The MZ entry point (CS=0x1788) is a small stub that jumps to the EXEPACK
  header at image 0x17720 (`RB` signature; real CS:IP = 0000:E94A, SS:SP = 1885:0800, dest = 0x1821 paragraphs).
  Unpacked with a small Python script (backwards RLE, 3 relocations); decompression ends exactly at offset 0.
  The earlier Ghidra dump of the *packed* file has wrong offsets past the first compressed run; use the unpacked image.
- Code: a single segment at image 0; Ghidra loaded at 1000:0000, so `1000:xxxx` == image offset `xxxx`.
- **DS (DGROUP) = paragraph 0x0F0D** (from the MSC 1986 startup at 1000:E94A, `mov di,0F0Dh` relocated at 0xE961).
  `DS:x` == image offset `0xF0D0 + x`. Checks: "C Library - (C)Copyright Microsoft Corp 1986" at DS:0008,
  monster names at DS:0x19F3.. ("Pirate"), weapon names at DS:0x1AE9.. ("Hands").
- In the Ghidra C, negative constants are DS offsets: `-0x6aa0` == DS:0x9560.
- `TITLE.EXE` is not packed (not needed for these tables).

## Global data map (DS)
| DS | meaning |
|---|---|
| 0x0904 | walkable tile list |
| 0x0814/0x081C | moongate x/y [8] |
| 0x0822 / 0x1736 / 0x0872 | .ULT / .TLK / .DNG name pointer tables |
| 0x0844/0x0864 | location x/y [32] |
| 0x1E9A | monster name ptrs [36]; 0x1EE2 weapons [16]; 0x1F02 armour [8]; 0x1F12 weapon abbrevs; 0x1F32 class/townsfolk [16]; 0x1F52 reagents [8]; 0x1F62 spells [26]; 0x1F96 location names [33]; 0x1FC6 virtues [8] |
| 0x208C | spell MP [26]; 0x216E spell handlers; 0x277E mix recipes |
| 0x2334 / 0x2344 | weapon / armour class masks |
| 0x23D2 / 0x2406 / 0x242A | monster base HP / leader tile / (dead) group size |
| 0x2450 / 0x2460 / 0x2468 | weapon damage / armour defense / weapon ranged flag |
| 0x2512 | combat map (.CON) name ptrs |
| 0x46D2 / 0x4BDC | weapon / armour prices |
| 0x8322 | mantras |
| 0x9144.. | PARTY.SAV image (see below) |

## Monsters & combat (core)

### Functions
| addr | name | notes |
|---|---|---|
| 1000:1771 | rand8 | 16-byte additive generator at DS:0x8732..0x8741, returns byte DS:0x8732 |
| 1000:0AB1 | mod(n, r) | `n==0 ? 0 : r % n` (used as `rand(n)`) |
| 1000:4FBE / 4FD7 | abs / sign | |
| 1000:7C25 | monster_index(tile) | tile<0x80: (t&0x1F)+0x24; t<0x90: (t&0x7F)>>1; else ((t&0x7F)>>2)+4 |
| 1000:1513 | creature_name(tile) | |
| 1000:0AFE | is_non_evil(tile) | t<0x80 or 0x8A,0x90,0x94,0x98,0xB4,0xCC |
| 1000:636D | is_undead(tile) | 0x9C,0xBC,0xC4,0xE4 |
| 1000:7E7E | combat_spawn_group | count / leader promotion / HP |
| 1000:7C65 | combat_pick_map | .CON chooser |
| 1000:7DFE | combat_start_from_map_monster | |
| 1000:5A6B | combat_main_loop | |
| 1000:61D1 | player_attack_cmd | direction, halberd reach, dagger throw |
| 1000:60F1 | player_ranged_attack | ammo (dagger/oil), Range prompt for oil |
| 1000:6012 | player_hit_roll_and_damage | |
| 1000:5DAB | monster_take_damage | XP, wound text |
| 1000:9F7B | monsters_turn (combat) | fields, Zorn negate, Wisp teleport, wake 1/8 |
| 1000:9CBC | monster_ai | ranged 1/4, sleep spell, flee, steal, melee |
| 1000:9A41 | monster_ranged_kind | |
| 1000:978C | monster_ranged_attack | effects on hit |
| 1000:9BE5 | monster_melee | armour roll |
| 1000:96B9 | monster_damage_player | |
| 1000:98E4 | monster_can_enter(tile) | sea/flying/ghost rules |
| 1000:9C56 | monster_flees_off_map | non-evil -> Compassion+1, Justice+1 |
| 1000:837A | combat_end | fled vs evil: "Battle is lost!" Valor-2; fled vs non-evil: Compassion+2 Justice+2; victory vs evil: Valor + (rand&1) |
| 1000:8283 | drop_chest | |
| 1000:1135 | damage_player(n,i) | HP<n -> HP 0, status 'D' |
| 1000:097D | add_xp | cap 9999 |
| 1000:09B1 | heal_player | cap at HPmax |
| 1000:09F8 / 0A17 | karma_inc / karma_dec | inc: no-op at 0, cap 99; dec: at 0 -> 99 + "Thou hast lost an Eighth!", floor 1 |
| 1000:1C53 | end_of_turn (world/town) | sleep/poison, food, ship hull, monster move+spawn, move counter |
| 1000:87E2 | end_of_turn (dungeon) | same + dungeon monster move/spawn, torch countdown |
| 1000:138B | eat(n) | food (hundredths, 32-bit DS:0x9284) -= n; <0 -> 0 and returns starving |
| 1000:13B6 | mp_regen | +1/turn up to class max (cap 99) |
| 1000:5851 | world_spawn | |
| 1000:5712 | world_monsters_move | |
| 1000:5293 | town_npcs_move | |
| 1000:95AA / 9414 | dungeon_spawn / dungeon_monsters_move | |
| 1000:9209 | terrain_effects | bridge trolls, swamp/fields, dungeon traps (Winds / Falling Rocks / Pit) |
| 1000:1584 | party_hazard_damage | ship hull -10 or 10+rand%15 each 50% |
| 1000:29EF | slow_terrain | |
| 1000:2999 | is_walkable | list DS:0x0904 |
| 1000:7631 / 7732 | ready_weapon / wear_armour | class masks |

### Party record (PARTY.SAV image in DS)
Save block starts DS:0x9144: +0 ?, +4 moves (32-bit, DS:0x9148); 8 members x 0x27 bytes at DS:0x914C:
`+0 hp, +2 hpMax, +4 xp, +6 str, +8 dex, +0xA int, +0xC mp, +0xE ?, +0x10 weapon, +0x12 armour, +0x14 name[16], +0x24 sex, +0x25 class, +0x26 status ('G','P','S','D')`.
Then DS:0x9284 food (32-bit, x100), 0x9288 gold, 0x928A karma[8] (Honesty, Compassion, Valor, Justice, Sacrifice, Honor, Spirituality, Humility), 0x929A torches, 0x929C gems, 0x929E keys, 0x92A0 sextants, 0x92A2 armour[8], 0x92B2 weapons[16], 0x92D2 reagents[8], ... 0x931C party size, 0x931E transport tile, 0x9320 torch/balloon word, 0x9326 ship hull (max 50).
Other globals: DS:0x946A game mode (1 world, 2 town, 3 dungeon, 4/5 combat, 6 dungeon room), DS:0x9338 location id (0 = world, 0x18 = Abyss), DS:0x95A4 active spell effect ('P','J','N','Q', 7 = none), DS:0x946E its countdown, combat monsters: tile DS:0x9560[16], HP DS:0x9550[16], x DS:0x9470[16], y DS:0x9480[16], asleep DS:0x9580[16].

### Formulas
```
player hit:   hit = DEX >= 40 || rand8 <= DEX + 128          (Abyss: only weapons > 10 can hit)
player dmg:   rand8 % min(255, STR + weaponDamage[w])
monster melee hit: !(Protection && rand8&1) && rand8 > armourDefense[a]
monster dmg:  r = rand8 % (baseHp>>2); dmg = (r>>4)*10 + r%10    (BCD-style quirk, kept literal)
monster HP:   (baseHp>>1) | (rand8 % baseHp)
XP on kill:   (baseHp>>4) + 1   (to the attacker; cap 9999)
group size:   n = rand8&7 ? 1+(rand8&7) : 1; while ((n-1)>>1 >= party) n = 1 + rand8 % (2*party)
              (the DS:0x242A table is only reached with index 36 -> value 1, and for human tiles with
               out-of-range indexes; i.e. it is effectively dead data)
leader:       for each monster but the last: 1/32 -> leader(leader(t)); else 1/8 -> leader(t)
monster AI:   1/4 ranged if it has one; Reaper/Balron 1/4 mass sleep; HP<24 flee; adjacent (dist<2):
              Gremlin steals 25 rations, Rogue 1/4 steals rand&0x3F gold, then melee; else step toward nearest member
food:         every world/town/dungeon turn food -= partySize (1 = 0.01 ration); starving: 2 dmg each
world spawn:  1/16 per turn; sea 1/8 on water; land tile = 0xC0 + 4*(r1 & r2 & mask), mask 3/7/15 by moves 10000/30000
dungeon spawn: 0x90 + 4*((r&3)+level), mimic excluded, 2 slots per level, every turn
```

### Open questions (core)
- DS:0x242A per-monster table (1,1,12,4,4,8,1,1,12,12,6,4,15,...) looks like an intended max group size but the
  code overwrites the index before reading it (see 1000:7E7E @ 7EBE-7EC9). Reimplementations may prefer to use it.
- Leader table entries look odd for some monsters (Rat -> 0xC4 Skeleton, Bat -> 0xE9 (Lava Lizard frame)); kept verbatim.
- Human HP values come from reading past the monster HP table; kept verbatim.

## Spells / mixing / upkeep notes (AVATAR.EXE unpacked, DS=0x0F0D -> image 0xF0D0)

### Addresses
- 1000:6E4A cast_spell: Player prompt (non-combat), spell letter, mixtures DS:0x92E2[26 words], MP check vs DS:0x208C[spell]; dispatch DS:0x216E[spell].
- 1000:63B4 spell_pay_mp: MP -= cost, sfx, fails if DS:0x95A4=='N' (Negate active).
- 1000:6399 spell_failed ("Failed!"). 1000:6409/6428/6447 context checks (Outdoors/Combat/Dungeon Only).
- 1000:6466 spell_projectile(type 'M'/'O'/'N'/0x8C) -> 1000:5DAB monster_take_damage.
- 1000:636D is_undead(tile) = 0x9C,0xBC,0xC4,0xE4.
- 1000:8C08 mix_reagents: recipe DS:0x277E[26] (bit 0x80=Sulfur Ash .. 0x01=Mandrake), exact match; cap 99.
- 1000:13B6 mp_regen (+1/turn, class max). 1000:138B eat_food(partySize) on 32-bit DS:0x9284.
- 1000:1C53 end_turn_world, 1000:87E2 end_turn_dungeon, 1000:8AB0 camp, 1000:8A5A camp_ambush.
- 1000:09B1 heal(amount, player) cap at max HP; 1000:1135 damage_player (status 'D' at 0).
- 1000:0A17 karma_decrease(n, &virtue) (0 -> 99 first?? i.e. if virtue==0 (Avatar) it resets to 99 and prints "Thou hast lost an Eighth!"; result floored at 1). 1000:09F8 karma_increase (no-op at 0, cap 99).
- 1000:7150 chest_open_trap, 1000:722F get_chest (map), 1000:7337 get_chest (combat).
- Player record: 0x27 bytes at DS:0x9146 + i*0x27: +0 HP (0x914C-0x6?), fields used: HP DS:0x914C, MaxHP 0x914E, XP 0x9150?, STR 0x9152, DEX 0x9154, INT 0x9156, MP 0x9158, weapon 0x915C, armour 0x915E, class 0x9171, status 0x9172 ('G','P','S','D').
  (offsets from decomp: -0x6EB4 HP, -0x6EB2 MaxHP, -0x6EAE STR, -0x6EAC DEX, -0x6EAA INT, -0x6EA8 MP, -0x6EA4 weapon, -0x6EA2 armour, -0x6E8F class, -0x6E8E status.)
- Globals: DS:0x946A mode (1 world, 2 town, 3 dungeon, 4/5 combat), DS:0x931C party size, DS:0x931E party tile (0x10-0x13 ship, 0x14 horse?, 0x18 balloon, 0x1F on foot), DS:0x9320 light/torch turns, DS:0x9326 ship hull, DS:0x9336 dungeon level, DS:0x9338 location id (0 world, 1 LB castle .. 0x18 Abyss; name = DS:0x1F96[id-1]), DS:0x95A4 active timed effect char, DS:0x946E its turns left, DS:0x96F2 wind dir, DS:0x9148 move counter (32-bit), DS:0x932A last camp (moves/100).

### Verified
- All 26 MP costs, recipes, handler addresses, context restrictions, damage formulas, gate coords, mixing rules, MP max per class, food/starve/poison/sleep per-turn rules, camp rules, chest traps.

### Caveats / open
- Recipes differ from some manuals only where binary says so (e.g. Heal = Ginseng+Spider Silk, Sleep = Ginseng+Spider Silk) - binary is authoritative.
- Dispel in world/town gated by DS:0x9320==0 (purpose unclear in that mode).
- Energy field in dungeon: field written even when "Failed!" printed (original bug).
- Blink distance depends on the 32x32 map window position (DS:0x959C/0x959D = party pos within window); not a fixed distance.
- Resurrect leaves HP as stored (0) - verify in game.
- Food unit: food shown = DS:0x9284/100 (standard U4 save format) - display not checked here (UNVERIFIED).

## Shops / Lord British / Hawkwind — RE notes

Addresses refer to the unpacked AVATAR.EXE (DS = 0x0F0D, DS:x = image 0xF0D0+x;
code 1000:x = image x). Town index DS:0x9338 is 1-based (1 LCB … 16 Cove, same order
as ULT ptr table DS:0x0824).

### Functions
| addr | name |
|---|---|
| 1000:a6f3 | talk_cmd (detects counter tile 0x60..0x7E + merchant NPC 'R'=0x52) |
| 1000:a686 | shop_dispatch(counterRow): table DS:0x2CCC[town*8+kind], handlers DS:0x2D54 |
| 1000:d085 / cd80 / cd1d / cebe | weapon shop menu / buy / pay / sell |
| 1000:d4ae / d1d0 / d16d / d2f8 | armour shop menu / buy / pay / sell |
| 1000:caf6 | reagent shop |
| 1000:e088 | food shop |
| 1000:dfaf / dd24 / de35 | tavern menu / food / ale+rumours |
| 1000:d8dd / d7d6 / d7a8 | inn / sleep+heal / night ambush |
| 1000:dc4d / daa2 / db29 / db93 / dbf5 | healer menu / cure / heal / resurrect / blood donation |
| 1000:d61e | guild shop |
| 1000:d596 | horse seller (Paws) |
| 1000:c922 | Hawkwind |
| 1000:e59b | Lord British talk |
| 1000:e4c3 / e498 | LB level-up check / stat gain (+1..8, cap 50) |
| 1000:e442 / e408 | LB "health" / heal whole party |
| 1000:e21e | LB "help" progressive advice |
| 1000:e37e | keyword lookup (4-char compare) vs DS:0x6FF0 |
| 1000:09f8 | karma_inc(n, &k): no-op if k==0, else min(99,k+n) |
| 1000:0a17 | karma_dec(n, &k): if k==0 {k=99; "Thou hast lost an Eighth!"}; k-=n; if <=0 → 1 |
| 1000:0e82 | member_alive(i): status 'G' or 'P' |
| 1000:0e4e | member_conscious(i): status 'G','P','S' |
| 1000:09b1 | heal_member(n,i): hp=min(hp+n,maxhp) |
| 1000:0e0e | redraw gold |

### Data layout found
- Party record: 0x27 bytes starting DS:0x914C: +0 hp, +2 maxhp, +4 xp, +6 str, +8 dex,
  +0xA int, +0xC mp, +0x10 weapon, +0x12 armour, +0x14 name[16], +0x25 class, +0x26 status
  ('G','P','S','D').
- DS:0x9284 food (uint32, x100), DS:0x9288 gold, DS:0x928A karma[8], DS:0x929A torches,
  0x929C gems, 0x929E keys, 0x92A0 sextants, weapons inv DS:0x92B2+2*i,
  armour inv DS:0x92A2+2*i, reagents DS:0x92D2+2*i; DS:0x931C party size, DS:0x931E
  transport tile (0x1F on foot, 0x14 horse), DS:0x9148 move counter (uint32),
  DS:0x9316 items bitfield, DS:0x931A stones, DS:0x931B runes, DS:0x9328 met-LB flag,
  DS:0x932E Hawkwind last-visit (moves/100).

### Formulas (pseudocode)
```
weapon/armour buy:  cost = price[i]*qty; if cost <= gold: gold -= cost; inv[i] = min(99, inv[i]+qty)
weapon/armour sell: gold = min(9999, gold + (price[i]*qty >> 1)); inv[i] -= qty
reagent buy: due = price*qty; player enters paid
   if paid < due: pen = (due-paid) < 12 ? 4 : (due-paid)/3; dec honesty,justice,honor by pen
   if paid <= gold: inc honesty,justice,honor by 2; gold -= paid; reagent = min(99, +qty)
food: per pack of 25: gold -= price; food += 2500 (x100), clamp 999900
tavern food: per plate: gold -= price; food += 100, clamp 999900
ale: 2gp nominal, enter amount (<2 refused); max 3/visit; paid>=3 -> ask topic;
   answered iff topicIdx >= tavernIdx; must reach cumulative price[topic]
inn: party HP += 100 + 2*(rand%50) (all conscious members, cures poison);
   1/8 rogue ambush (if Avatar alive), else Skara Brae 1/4 ghost spawn
healer: cure 100 (free if gold<100), heal 200 (full), resurrect 300;
   Avatar HP>=400 → blood offer: yes sacrifice+5 HP-100, no sacrifice-5
horse: 100*partySize gp → transport = horse
LB level: target = 100*(1 + #{k>=0 : 100*2^k <= xp}); if maxhp<target: maxhp=hp=target, Good,
   str/dex/int += 1+rand(0..7), cap 50.  XP thresholds 100,200,400,800,1600,3200,6400 (lvl 2..8)
Hawkwind: level = karma<20?0:<40?1:<60?2:<99?3:4 (karma 0 = elevated msg);
   leaving: once per 100 moves spirituality += 3
```

### Open questions
- Tavern rumour gating `topic >= tavernIndex` (1000:def6 CMP/JGE) looks like a bug;
  xu4 behaviour may differ. Implemented as-is in notes.
- The armour keeper table has 6 names (…, Limpy, Big John) but only 5 shops; "Big John"
  is unreachable via the index computation.
- Shop key is the Y coordinate of the counter tile (from talk direction); exact meaning when
  talking horizontally vs vertically should be checked against the .ULT maps.
- Reagent shops sell only A–F (Nightshade/Mandrake are found, not bought).

## World / virtues

Source: unpacked AVATAR.EXE image, DS = image 0xF0D0. (Scratch extraction scripts were kept outside the repo.)

### Game-state variables (DS)
- 9148/914A: 32-bit move counter. 914C.. party records 0x27 bytes each: +0 hp, +2 maxHp, +4 xp (cap 9999, 1000:097D), ..., +0x25 class, +0x26 status ('G','P','S','D').
- 9288 gold; 928A..9298 karma[8] (Honesty..Humility); 929A torches, 929C gems, 929E keys.
- 9316 item flags (see ITEM_FLAGS); 931A stones; 931B runes; 931C party size; 931E transport tile (0x10-0x13 ship, 0x18 balloon, 0x1F on foot).
- 9318/9319 x/y; 9332/9333 saved overworld x/y; 9336 dungeon level; 9334 dungeon facing (0 W,1 N,2 E,3 S; dx DS:080C, dy DS:0810).
- 9338 current location id (0 overworld, 1..32 = LOCATIONS). 946A mode (1 world, 2 town, 3 dungeon, 4 combat, 6 dungeon room, 7 shrine).
- 9322/9324 trammel/felucca phase; 96F2 wind dir; 932E last meditation/Hawkwind (moves/100); 9330 last karma gain (moves>>4); 932C last reagent search (moves&0xF0).

### Functions
- 1000:4018 cmd_enter (tile dispatch); 3E30 load_town(id); 3F03 enter_dungeon; 3EE4/3E94 load_dungeon; 3F4A enter_town; 3FB9 enter_abyss; 2747 exit_town.
- 2A91 moongate_step; 3A80 moon_tick; 3A4F moongate_open_pos; 35C7 wind_tick; 353D draw_wind; 2A5A sail_wind_check; 2B8C/2C8A/2DA9/2EC5 move N/S/E/W.
- E72C shrine_meditate; E6DF show_vision_pic; C922 hawkwind; E21E lord_british_help; A2BD npc_join; A163 npc_yes_no (humility); A3A2 give_beggar.
- 09F8 karma_inc(n,&k); 0A17 karma_dec(n,&k); 0AFE is_non_evil(tile); 097D add_xp(n, player).
- 07AE cmd_use (table DS:0434: name, handler); 0311 use_stone; 01E1 altar_room_stones; 0487 bell; 04C0 book; 0501 candle; 044C key; 0553 horn; 058C wheel; 05CE skull.
- 913A cmd_search (table DS:2920); 8D4B found_item (+5 honor); 8DAA mandrake; 8DE0 nightshade; 8E16 bell; 8E46 horn; 8E77 wheel; 8EA8 skull; 8EE8 black stone; 8F21 white stone; 8F51 book; 8F81 candle; 8FB1 telescope; 9027 mystic armour; 9076 mystic weapons; 90C5 rune; B93F altar stone.
- 31F4 codex_chamber; 310F ask_3_tries(answer,question); 2F9D abyss_eject(i) (positions DS:0BF0/0BFE); 3010 passage_not_granted; 3025 ending.
- 837A combat_end (victory / flee karma, altar-room exits DS:261A); 7962 player_flee; 9C56 monster_flee; 96B9 monster_hits_player; 628F cmd_attack.

### Formulas
- Moons: real-time ticks (countdown from CPU-speed calibration DS:8728), not move-based. Per tick sub+=0x40; on wrap trammel+=2, felucca+=6; phase=byte>>5.
  Open gate = MOONGATES[trammel]; stepping onto gate tile 0x43 -> MOONGATES[felucca]; (4,4) -> Spirituality shrine.
- Wind: per tick 1/64 chance to rotate +-1. Sailing into wind (d==wind) 1/4 turns, with wind ((d+2)&3==wind) 3/4 turns, crosswind always.
- Meditation and karma: see part_world.ts KARMA_EVENTS / MEDITATION (all 47 inc/dec call sites enumerated).
- Join: karma>=40 (or 0) and avatar maxHP >= 100*partySize+100.
- Hawkwind tiers: <20,<40,<60,<99,==99.
- Lord British help (E21E) decision order: moves<1000 -> beginner text; party size 1 -> recruit; no runes -> runes/shrines; not all virtues elevated: no stones -> stones text, else per-virtue text; all elevated: missing bell/book/candle -> BBC text; missing key parts -> key text; else final "ready" text.

### Open questions
- Moon counters DS:1664-1666 are only ever incremented; no load from the saved phases DS:9322/9324 was found -> phases may restart at 0 each launch (UNVERIFIED; xu4 reloads them).
- Exact semantics of horn (DS:95A4=1, DS:946E=10) not traced.
- Tile 0x4C at (233,233) also triggers Abyss entry (probably the tile after the candle sequence) - not traced.
- Telescope (8FB1) handler not detailed.

## PC speaker (sound effects)

### Mechanism
- **1000:1D47(n, p1, p2)** is the only sound entry point of AVATAR.EXE (98 call sites). `bl = n`, `cl = p1`,
  `ch = p2`; it returns at once when the sound flag **DS:06A6** is 0 or `n >= 13`, else calls the near routine
  `word [DS:06A7 + 2n]`. DS:06A6 is 1 at start-up.
- The routines never program the PIT (no port 0x42/0x43 access anywhere in the program). Each one reads port
  0x61, clears bits 0-1 (timer gate off, speaker data off) and toggles bit 1 (`xor al,2; out 61h,al`) between
  busy-wait loops: the waveform is a 1-bit square wave whose half-periods are the loop lengths. Port 0x61 is
  restored at the end. No other routine touches the speaker.
- **Timing unit**: the delay counts are multiplied by **DS:8728**, measured once at start-up by 1000:0012: INT 1Ch
  is hooked, the loop at 1000:00CF..00EC (INC mem / JS / MOV DX,[BX+1F40] / MOV DX,ES:[BX+SI+1F40] /
  MOV DX,[BP+SI] / MOV DX,0 / MOV CL,14h / RCR DX,CL / CMP CS:[10h],AX / JZ: 232 cycles on an 8088) runs for one
  timer tick (65536/1193182 s = 54.925 ms), and the count / 1000 (minimum 1) is kept. A calibrated loop of
  `c` cycles run `K*m` times therefore lasts `m * c * 54925.4 / 232000 µs = m * c * 0.23675 µs` on any CPU. The
  same factor drives the moon/animation countdown (1000:1744). Two loops are not calibrated (effects 0 and 4);
  for them a 4.77 MHz PC is assumed. Loop overheads (`out`, `mul`, the random call) are ignored.
- **V)olume**: key word 0x2F76 (v) in the three dispatchers (world/town 1000:1AD4, combat 1000:5BC2, dungeon
  1000:85D9) calls **1000:70AD**: prints DS:222E, flips DS:06A6, prints DS:2237 (now on) or DS:223B (now off).
  The command then ends the turn like any other (world 1000:1C06, combat 1000:5B73, dungeon 1000:857E + 87E2).
  The flag is not saved.
- Noise effects draw their bytes from the game generator 1000:1771.
- Many effects come with screen effects: 1000:2241 (viewport invert) before and after effect 9; 1000:224B(i)
  (invert member i's status line) around effect 7 (helpers 1000:09D9, 9764, 96B9, B730) and around effect 6 in
  1000:1584 / 1C53 / 87E2; 1000:095E (screen shake) after effect 6 in 0501/05CE/1584. See "Screen inverts" below.

### Effect table DS:06A7
Durations from the model above ("half" = half-period, the time between two toggles).

| n | routine | waveform | duration |
|---|---|---|---|
| 0 | 1D69 | one pulse: speaker on for 50 passes of DEC/JNZ (18 cycles, not calibrated) = 0.19 ms | 0.2 ms (a click) |
| 1 | 1D82 | 16 halves of 0xCA*K passes of DEC/PUSHF/PUSH/POP/POPF/JNZ (71 cycles) = 3.40 ms: 147 Hz buzz | 54 ms |
| 2 | 1DA8 | 48 halves of 0xE0*K x 18 cycles = 0.95 ms (524 Hz), then effect 1 | 100 ms |
| 3 | 1EB3 | bl = 5..255: half = K*bl/2 x 24 cycles (bl x 2.84 µs): falling sweep, ultrasonic down to 690 Hz | 93 ms |
| 4 | 1EFD | bl = 0 first: K*0/2 = 0 and `dec cx` wraps, 65536 x 24 cycles (not calibrated) = 330 ms of silence; then bl = 255..128, half = bl x 2.84 µs: rising 690 -> 1370 Hz | 399 ms |
| 5 | 1F4A | bl = 128..255, half = K*bl/2 x 30 cycles (bl x 3.55 µs): falling 1090 -> 555 Hz | 87 ms |
| 6 | 1E7F | 255 halves, r = (rand & 0x7F) \| 1, half = (3*r*K/4) x LOOP (17 cycles) = r x 3.02 µs (3..383 µs): crackling noise | ~50 ms |
| 7 | 1E53 | 255 halves, r = (rand & 0x7F) \| 0x40, half = r*K/2 x 24 cycles = r x 2.84 µs (182..361 µs, 1.4-2.8 kHz): hiss | ~46 ms |
| 8 | 1F22 | bl = 128..1, half = round(K*bl/2) x 24 cycles: fast rising sweep 1.4 kHz -> ultrasonic | 23.5 ms |
| 9 | 1DCD(p) | K' = ceil(K/2); 53 steps of 48 pulses, on for (p+1-c)*K' and off for c*K' passes of 18 cycles, c = 1..26 then 27..1: constant pitch 1/((p+1) x 2.13 µs) with the pulse width swept up and down. p = 0x60+spell: 4.8-3.8 kHz, 0x80: 3.6 kHz, 0xA0: 2.9 kHz, 0xC0: 2.4 kHz, 0xFF: 1.8 kHz | 2544 x (p+1) x 2.13 µs: 0.53 s (0x60) .. 1.39 s (0xFF) |
| 10 | 1F73(p) | p bursts (0 = 256) of 40 halves; r = (rand & 0x3F) + 0x40 per burst, half = 2*r*K x 18 cycles = r x 8.52 µs: 460-920 Hz noisy chirps | ~33 ms per burst |
| 11 | 1FA3 | cx = 0x40..0xBF, 20 halves each of cx*K x (NOP/DEC/JNZ, 21 cycles) = cx x 4.97 µs: falling 1570 -> 530 Hz | 1.62 s |
| 12 | 1FCC | cx = 0xC0 down to 0x41, as 11: rising 525 -> 1550 Hz | 1.64 s |

1000:1ED8 (between 1EB3 and 1EFD) is a 14th routine missing from the table (rising sweep, half = (160..1)*K x
18 cycles); unused.

### Call sites (98)
| n | where (1000:xxxx) | what | port |
|---|---|---|---|
| 0 | 2B19/2B8C, 2C25/2C8A, 2D44/2DA9, 2E4F/2EC5 (N, S, E, W) | on foot / horseback: once for the command, once more for a step actually taken (not when slowed); the second step of the flag DS:95C6 clicks again | Game.move |
| 0 | 7AE3 (x2) | combat move: same pattern | combat moveMember |
| 1 | 29C3 | blocked message (DS:0929) + keyboard flush; from the walk routines, 7AE3, dungeon 891E/895F | Game.blocked (move, sail, dungeon, combat; no flush) |
| 1 | 11F9, 12D6, 1445, 162F | key prompt out of range, direction prompt with another key, line input full / backspace on empty, Y/N prompt | prompts.ts, Game.askDir |
| 1 | 75DC | weapon not allowed for the class | actions readyWeapon |
| 1 | 8D6D | reagent found over 99 (DS:27B5) | items findReagent |
| 1 | 794D | dungeon room: members must leave by the same exit (DS:239E) | combat moveMember |
| 1 | 44EE | balloon cannot land here (not grass) | places descend |
| 1 | 4CC1 | Z)tats: member number out of range | actions ztats: the member prompt 1000:1287 (11F9) buzzes the same way; no stats browser |
| 1 | C454 | disk swap prompt, wrong drive | not applicable |
| 1 | CAF6, CD80 (x2), CEBE, D085, D1D0, D4AE, DD24, DE35, DFAF | shops: negative amounts, item not sold here, wrong key at the buy/sell or tavern menu | shops.ts |
| 2 | 191E (1A29), 5A6B (5BFC), 84D2 (8562) | bad command (world/town, combat, dungeon) | Game.command, combat playerTurn, dungeon command |
| 2 | 84D2 (85EF) | dungeon: command not available underground (DS:0606) | dungeon command |
| 2 | 73C9 | cannons: not a broadside | items fireCannon |
| 3 | 73C9 | the party's cannon fires | items fireCannon |
| 3 | 5569 | a pirate ship fires, or a sea serpent / lava lizard / dragon breathes (564B) | world/monsters fireAtParty |
| 3 | 978C | a monster's missile, field or spell leaves | combat monsterRanged |
| 4 | 61D1, 60F1 | the party's attack (melee swing, missile launch) | combat attack |
| 4 | 5F9D | miss with nothing in the way (param 0): the attack sound again | combat missed() |
| 5 | 9BE5 | a monster's melee attack | combat monsterMelee |
| 6 | 6012 | the party hits a creature | combat resolveHit |
| 6 | 6466, 6BF8 | projectile spell / Tremor hits | magic projectile, Tremor |
| 6 | 9F7B (x2) | a monster on a damaging field / falling asleep on a sleep field | combat monstersTurn (damaging fields; the port has no sleep-field case) |
| 6 | 9B03 | Jinx: a monster steps onto another and hits it | combat jinx() |
| 6 | 5569, 73C9 | a cannonball hits an object | world/monsters fireAtParty, items fireCannon |
| 6 | 1584 | party hazard (bomb trap, falling rocks, pit, cannonball/fire bolt, whirlpool, twister) | endgame/ui hazardFlash: chest bomb (actions, dungeon), dungeon hazard, world/monsters partyHazard |
| 6 | 1C53 (x2), 87E2 (x2) | end of turn: poisoned member, starving party | Game.endTurn (also used underground) |
| 6 | 0501 | candle at the Abyss entrance + shake | items useAbyssItem |
| 6 | 05CE (x6) | skull: 3 x (sound + shake + flash), both cases | items useSkull |
| 7 | 09D9 | member hurt: chest traps (7150/70CE), dungeon fields (9209, 919A, 91D1), combat fields | chest traps, dungeon fields, combat terrainEffect |
| 7 | 96B9, 9764 | a monster's blow or missile hits a member | combat monsterMelee / monsterRanged |
| 7 | B730 (x3) | orb and fountain damage | dungeon hurt() |
| 8 | 6399 | spell failed | magic failed() |
| 8 | 7150 | chest trap evaded | actions openChest, dungeon chestTrap |
| 8 | 7962 | a member leaves the combat map | combat moveMember |
| 8 | 9C56 | a monster flees off the map | combat monsterAct |
| 8 | 9B6B, 9BA6 | food / gold stolen | combat monsterAct |
| 8 | C51C | no party formed (start-up) | not applicable |
| 9 (0xA0) | 2A91 | moongate: entering and arriving; the Spirituality gate before the shrine | world/sky checkMoongate |
| 9 (0x60+spell) | 63B4 | every spell paid, between two screen inverts | magic pay() |
| 9 (0x80) | 9CBC | Reaper/Balron sleep spell | combat monsterAct |
| 9 (0xC0) | DA79 | healer: cure, heal, resurrect | shops healer |
| 9 (0xC0) | E442, E59B, E4C3 | Lord British heals, resurrects, raises a level | talk.ts |
| 9 (0xFF) | E72C | partial Avatarhood at a shrine | shrine.ts |
| 10 (MP) | 63B4 | every spell paid: one burst per MP point | magic pay() |
| 10 (10 / 0x14) | E442 / E59B | Lord British heals / resurrects | talk.ts |
| 11 | 786F, 7821 | whirlpool takes the party or an object | world/monsters whirlpool, swallow |
| 12 | 78D1, 7821 | twister hits the party or an object | world/monsters twister, swallow |

TITLE.EXE has its own routines: see "TITLE.EXE sounds" below.

### Port (src/audio/speaker.ts)
- `effectSpans(n, p)` replays each routine as a list of toggle intervals (the model above, unit-tested in
  tests/speaker.test.ts), `renderSpans` turns it into samples (area-sampled 1-bit wave + DC blocker) and
  `playEffect(n, p)` plays them through an AudioBufferSourceNode. Effects are queued one after the other and the
  promise resolves when the effect has played, as the original blocks; callers await it where the original
  blocks the game; a few synchronous spots (end of turn, reagent overflow) fire and forget.
- The AudioContext is created on the first user gesture (pointer/key/touch). Without it (tests, node, before
  any gesture), with the sound off (config `sound.enabled`, toggled by V) and under the test clock (?seed),
  `playEffect` resolves at once: the original does not wait either when its flag is off, and nothing in the
  game logic depends on the wait, so the headless scenarios keep their timing.
- The noise uses a separate seeded stream (`soundRand8` in rng.ts) so that the game rolls do not depend on
  whether the sound is on.
- `playSpans(make, cacheKey?)` is the same queue/promise for any toggle list (used by the TITLE.EXE sounds);
  `playEffect(n, p)` is `playSpans(() => effectSpans(n, p), key)`.

### Screen inverts
- Both are EGA.DRV entries (far table at the driver start, called through 1000:2255 with DS:8C46 = the driver's
  load address). They set the sequencer map mask to 7 and the graphics controller to XOR (data rotate 0x18),
  then OR 0xFF into video memory: the colour planes 0-2 are flipped, intensity is kept, so EGA colour c becomes
  **c ^ 7** (black <-> light grey, white <-> dark grey, green <-> magenta, blue <-> brown...) and a second call
  restores the screen.
  - **1000:2241 -> entry 0x12** (EGA.DRV 0x0646): lines 8..183 (0xB0 lines from the line table at
    driver 0x52 + 0x10), bytes 1..22 of each: the 176x176 map viewport at (8, 8).
  - **1000:224B(i) -> entry 0x16** (EGA.DRV 0x06C9): 8 lines from line (i+1)*8, 15 bytes from byte 0x18: member
    i's status line (text columns 24..38 of row i+1).
  - (Entry 0x14, 1000:2246, EGA.DRV 0x0694, clears the viewport the same way with a plain write.)
- Pattern: invert, sound, invert. Sites: 2241 around effect 9 in 2A91 (moongate: before leaving and after
  arriving; for the Spirituality gate only once, the shrine screen replaces the viewport), 63B4 (spells),
  9CBC (Reaper/Balron sleep), DA79 (healer, with the member's line), E442/E4C3/E59B (Lord British), E72C
  (partial Avatarhood); 05CE (skull): sound+shake, invert, sound+shake, invert, sound+shake. 224B around effect
  7 in 09D9 (fields, chest traps), 96B9/9764 (a monster hits a member; the hit tile shows meanwhile), B730 (three
  hurt noises: orbs, fountains), DA79; around effect 6 for one member (1C53/87E2 poison) or every member, last
  first (1C53/87E2 starving; 1584 with the shake inside; when the ship sinks 1584 inverts a third time, but the
  status redraw 0CF7 right after wipes it). 4E45, 5A6B, 6E4A, 7631, 7732 also use 224B, without sound, to show
  the member being asked about or the combat member whose turn it is (not part of this port's inverts).
- Port: a layer part `invert` (src/ui/layers.ts: screen rectangles; two layers on the same area cancel like
  the XORs) pushed by src/ui/invert.ts (`inverted(host, rects, fn)`: the rectangles are inverted while `fn`,
  the sound, runs; `VIEWPORT_RECT`, `statusRowRect(i)`). The renderer (Renderer.setInverts / invertRect)
  copies each area of the finished frame to a texture and draws it back through a shader that matches every
  pixel against the 16 EGA colours (as drawn by the tile shader and, sRGB-encoded, by the UI layer) and outputs
  its c ^ 7 partner; colours of the other tile packs are RGB-inverted. It covers the tile grid, the 3D dungeon
  view and the UI text. The inversion lasts as long as the sound, so it is not seen when the sound is off (the
  original's two XORs are then back to back) nor under the test clock.

### Overworld events (pirates, fire breath, whirlpools, twisters)
- End of an overworld turn (1000:1C53): if the balloon does not fly (DS:9320 = 0): 1000:7918 (whirlpools and
  twisters), 1000:5834 -> 5712 (monsters act), 5851 (spawn), 7918 again. The port runs this after the command
  (Game.endTurn flags it, the main loop awaits world/monsters `worldTurn`), before a pending fight.
- **1000:5712**, per monster slot 7..0: distance |dx|+|dy| <= 1 (not whirlpool/twister) -> "Attacked by" and
  combat (7DFE). Else:
  - pirate ship (base tile 0x80, shown 0x80..0x83 = heading W/N/E/S, never animated by 1000:3605): distance
    < 4 and broadside (1000:568F: heading W/E and dx = 0, or heading N/S and dy = 0) -> it fires
    (564B with tile 0x4D); else 1000:5500 sails: it moves ahead (1000:53AF) when the party is ahead of it, else
    1000:5443 turns towards the party (when farther than 5 squares, or 1 time in 4; otherwise it moves ahead).
    53AF: the square ahead must be water (tile 0-1) without an object or the party (1000:4E94) and the wind
    must allow it (1000:2A5A, as for the party's ship); blocked, it turns by sign(rand) quarters.
  - base 0x88 (sea serpent), 0xE8 (lava lizard), >= 0xF4 (dragons, balron...): |dx| < 5, |dy| < 5 and rand & 1
    -> fires a 0x4F bolt (564B) towards (sign dy, sign dx), diagonal included; then it moves (5062).
- **1000:5569 / 564B** (the shot): effect 3, then up to 3 squares from the shooter by (sign dx, sign dy): the
  party's square -> 564B draws 0x4F on the party (DS:95AE at viewport 5,5, 1000:36C7) and calls 1584; an object
  (any slot, 0A58) -> effect 6, then a monster (slot < 8) survives 3 times in 4, any other object (ship, horse,
  balloon...) is removed; else the projectile tile shows on the square. No message.
- **1000:1584** (party hazard): the inverts, effect 6 and the shake (above); then on a ship (mode < 4 and
  transport < 0x14) the hull DS:9326 loses 10, and if it was below 10 it becomes 0, "Thy Ship Sinks!" (DS:0660)
  and the death sequence 1000:0EB1; otherwise each member, last first, 1 time in 2, if alive: 10 + rand % 15.
- **1000:786F** (whirlpool, base 0x8C, slots 0..3) on the party's square: the whirlpool tile is drawn on the
  party (DS:95AE = 0x8C), the party is moved to (0x7F, 0x4E), effect 11, 1584, then transport = 0x10 (ship
  facing west) and the map is reloaded (26B6). **1000:78D1** (twister, 0x8E) on the party: effect 12 and 1584
  four times. Both then call **1000:7821**(sound, slot): every other object on the vortex's square is removed,
  each with the vortex's sound. 4E94 lets whirlpools and twisters move onto the party and other objects.
- Port: world/monsters.ts (`worldTurn`, `fireAtParty`, `partyHazard`, `whirlpool`, `twister`, `swallow`;
  pirates keep their heading in the tile's low bits); the movement of the other monsters is the port's own
  (not 5062) as before.

### Other small rules with sounds
- **1000:794D** (from 1000:79C9, combat move off the map in a dungeon room, mode 6): the first member out sets
  the exit column DS:96EE (when x is off the map) or row DS:96F4; a member leaving by another edge gets "All
  must use same exit!" (DS:239E) and effect 1, and stays. Port: combat moveMember (`roomExit`).
- **1000:44EE** (D)escend) with the balloon (transport 0x18): "Land Balloon" (DS:1867); not on grass (tile 4):
  effect 1 and "Not Here!" (1000:11AA); already down: "Already Landed!" (DS:1875); else DS:9320 = 0 (and the
  line of sight flag DS:9440 = 1). **1000:4477** (K)limb) with the balloon: "altitude", DS:9320 = 1, DS:9440 = 0.
  Port: places klimb/descend (save.balloonState); the drift with the wind and the full view from the air are
  not ported.
- **1000:9B03** (Jinx, DS:95A4 = 'J'): in a monster's move (9CBC), a step onto another monster (59D5) shows 0x4F
  on it, effect 6, and does rand & 0x3F damage to it (5DAB with no attacker: name and state, no XP); the move
  ends there. Port: combat jinx() in the approach and flight steps.
- **1000:4CC1** (Z)tats browser): keys 1-8 above the party size -> effect 1. The port has no browser: Z)tats
  now asks the member with 1000:1287 like 4E45 (one member: answered at once), which buzzes on such a key.

### TITLE.EXE sounds
- Only four routines touch port 0x61; none programs the PIT (no port 0x42/0x43 access). There is no sound
  flag: the title program always plays them.
- **Timing unit**: DS:692E, measured by 1000:244E exactly like AVATAR's DS:8728 (INT 1Ch hooked with the
  handler at 1000:257D, the same 232-cycle loop from 1000:250B, count / 1000, minimum 1); in CGA mode
  (DS:7078 = 1) it is incremented once more. The delay 1000:02A3(n) busy-waits n*K passes unless a key is
  pending (the port's `Keys.delay`).
- **1000:21BF, buzz**: `mov ax,0CAh; mul [692E]`, then 16 x (out 61h with bits 0-1 cleared first, xor al,2,
  0xCA*K passes of DEC BX/PUSHF/PUSH AX/POP AX/POPF/JNZ), port 0x61 restored. Byte-for-byte the waveform of
  AVATAR.EXE's effect 1 (1000:1D82): 147 Hz, 54 ms. Call sites:
  | where | when |
  |---|---|
  | 1000:0EAA main loop (after the menu) | any key other than R, I, J (the key's glyph is printed first) |
  | FUN_1000_2656 line input (the name, 1000:2696) | Backspace (0x0E08 or 0x0E7F) or Left (0x4B00) with nothing typed; any key that is not Enter and not a character 0x20..0x7F, or when the buffer is full (11 characters), Escape included |
  | FUN_1000_3030 sex prompt | every key other than M/F; the next key then ends the prompt if it is Escape, Enter or Space |
- **Dissolve blits**, driver slot 0x0B (1000:11C2 -> table DS:03CE, entry slot*3 + mode - 1): 1000:1826
  (mode 1, CGA), 1000:173F (mode 2, EGA), 1000:160D (mode 3); the same routines with a negative step are the
  plain copies of slot 3 in modes 1 and 3. For each 8-pixel group that is not black (EGA: any plane byte
  non-zero) the routine steps its generator DS:03CC/03CD (initial 0x35, 0x9B): `dl = [3CC] + 1Dh; dh = dl;
  dl = dl + [3CD] + CF; [3CC] = dl; [3CD] = dh`; if `dl + step` carries, it flips bit 1 of port 0x61
  (`in/xor 2/out`); `dl & 7` + step indexes the mask table DS:32D0. Port 0x61 is read at entry and restored at
  the end. Lines are processed from the bottom one up, groups left to right. The toggle rate is set by the
  drawing (not calibrated): about 112 8088 cycles per black group, 503 per drawn one (542 with the toggle,
  which happens ~230 cycles in), ~270 per line. Only caller: the opening animation FUN_1000_068c, steps
  0..0x38 back to back with no delay (twice per step when K > 4); a pending key jumps to step 0x38. Over the
  title picture's 30x45 rectangle (657 drawn groups, 693 black) one pass is ~425,000 cycles = ~89 ms at
  4.77 MHz (5 s for the 57 passes): a crackle whose density rises with the step (step/256 of the drawn groups
  toggle, ~144 toggles per pass at 0x38).
- No other sound: the story pages, the moongate, the cards, the beads, the signature and the menu text are
  silent.

### Port (src/audio/titleSounds.ts)
- `titleBuzz()` = `playEffect(SFX.ERROR)`, awaited at the three call sites (src/intro/title.ts menu,
  src/intro/newgame.ts name and sex prompts). The port lets Escape leave the name and sex prompts, so it does
  not buzz there; the sex prompt buzzes on the other wrong keys.
- `dissolveSpans` replays one pass of 1000:173F over the picture with the cycle costs above (unit-tested in
  tests/titleSounds.test.ts with the generator written as add/adc), scaled to the port's pass time (25 ms, as
  on a machine ~3.6x a 4.77 MHz PC); `playDissolve` queues it after each `blitDissolve` without waiting (the
  original makes the sound while drawing, so the waits and the key skip are unchanged). Its generator only
  advances when the sound is heard and never touches the game's random stream.
