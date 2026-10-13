# Ultima IV — TypeScript + three.js + Tauri

*[Version française](README.fr.md)*

A reimplementation of **Ultima IV: Quest of the Avatar** (DOS version, as sold by GOG) written in
TypeScript, rendered with three.js and packaged as a desktop app with Tauri v2.

The engine was rebuilt by reverse engineering the original game: the data file formats were decoded
and the executables (`AVATAR.EXE`, after removing its EXEPACK compression, and `TITLE.EXE`) were
decompiled with Ghidra. Game rules, formulas and tables cite the original function addresses
(`1000:xxxx`) and data offsets (`DS:xxxx`) in comments. See `docs/RE_NOTES.md`.

## Game data and the original graphics

No original code is executed (no DOSBox, no emulation), and the engine does not read the original
files either: their content was **extracted** into modern formats by a TypeScript tool, and the game
only reads `assets/`.

**Shipped with the repository**: the maps, dialogues, tables and text catalogs extracted from the game
(`assets/original/`, JSON), their French translations (`assets/i18n/`), and the 2026 edition's own
graphics, sounds and music (PixelLab tile pack and illustrations, ElevenLabs effects, Suno tracks). A
fresh clone is playable as is, with the edition's look.

**Not shipped**: the original graphics (EGA tiles, 8x8 font, full-screen pictures) and the tile packs
derived from them. If you own Ultima IV (it is free on GOG), extract them once to play with the 1987
look (*Options*: tile pack `original` or `scale4x-derived`, original font, 1987 screen and title):

```powershell
npm run extract -- --game-dir "C:\Program Files\GOG Galaxy\Games\Ultima 4"
```

The tool (`tools/extract-assets.ts`) unpacks `AVATAR.EXE` (EXEPACK) in memory, reads its texts and
`TITLE.EXE`'s at the offsets declared in the source and rewrites `assets/original/` (the committed JSON
files come out unchanged from the GOG release). It adds the original graphics and builds the Scale4x and
Scale3x packs (`assets/packs/*-derived/`, `--no-packs` skips them); all of these are git-ignored.
Without `--game-dir` it uses `U4_GAME_DIR` or the GOG Galaxy location above. The original install is
never modified: saves go to the app data directory (Tauri) or to `localStorage` (browser mode).

A build leaves the original graphics out of `dist/` even when they have been extracted, so a deployed
site never serves them. For a personal build that includes them (your own desktop app), set
`U4_BUNDLE_ORIGINALS=1` before `npm run build` / `npm run tauri build`, and do not distribute it.

The source only declares *where* each original text lives (for example `talk.youSay: 0x2a62`, a DS
offset in `AVATAR.EXE`); the texts themselves come from the extracted catalog at runtime.

## Running

A Node.js runtime is provided in `.nodeenv`; Rust (MSVC toolchain) is required for Tauri.

PowerShell:

```powershell
$env:Path = "E:\IdeaProjects\u4\.nodeenv\Scripts;" + $env:Path
npm install
npm run tauri dev   # desktop app, front-end hot reload
npm run dev         # browser only: http://127.0.0.1:1420
npm run build       # type check + production bundle
npm test            # unit tests (Vitest); format tests are skipped without the install
node tools/scenarios.mjs [--ref]  # headless screenshot regression (dev server running)
npx tsx tools/packs/upscale.ts --algo scale2x  # one more pack derived from the extracted tiles (assets/packs/scale2x-derived)
```

Git Bash: `export PATH="/e/IdeaProjects/u4/.nodeenv/Scripts:$PATH"`, then the same commands.

In dev mode, `http://127.0.0.1:1420/?skipintro` starts directly on the overworld (used by the
automated tests); the game instance is exposed as `window.__game`.

## Project layout

| Path | Contents |
|---|---|
| `tools/extract-assets.ts` | one-time extraction of the original files into `assets/original/` (EXEPACK unpacker in `tools/exe`) |
| `src/formats` | decoders of the original formats, used by the extractor and the tests |
| `src/assets` | access to the extracted assets (`AssetStore`): tiles, font, pictures, maps, dialogues, texts, tile packs |
| `src/data` | rule tables cited by address (`tables.ts`) and the text registry (`text.ts`: texts declared by their location in the executables) |
| `src/game` | engine: state and main loop (`game.ts`), command registry (`commands.ts`), party commands (`actions.ts`), places and towns (`places.ts`), transports, world (`world/`), conversations (`talk.ts`, `conversation/` providers), shops, combat, dungeons, spells, items, shrines, endgame, prompts, karma; engine messages in `texts/` |
| `src/render` | three.js renderer: tile packs (any tile size), 11x11 grid, 320x200 UI layer (original or modern font), 3D viewport |
| `src/ui` | screen layers (`layers.ts`), status panel, HTML interface (`dom/`: command bar, panels, pointer/touch) and panels (`panels/`: inventory, world map, help, settings, debug) |
| `src/i18n` | languages: interface catalogs and the texts written for this port, per language |
| `src/intro` | title screen and character creation (gypsy cards) |
| `src/dungeon` | first-person dungeon view (three.js) and dungeon tables |
| `src/config` | configuration (`config.json`) and its defaults |
| `tests`, `tools/scenarios.mjs` | unit tests (Vitest) and headless screenshot regression scenarios |
| `tools/packs` | tile pack tools: `upscale.ts` builds HD packs from the original tiles with pixel-art scaling (Scale2x/3x/4x) |
| `src-tauri` | Tauri v2 shell: saves and configuration in the app data directory |
| `docs` | reverse-engineering notes, translation guide |

## Controls (keyboard, as in the original)

Arrows: move · A)ttack · B)oard · C)ast · D)escend · E)nter · F)ire · G)et chest · H)ole up ·
I)gnite torch · J)immy · K)limb · L)ocate · M)ix · N)ew order · O)pen · P)eer · Q)uit & save ·
R)eady · S)earch · T)alk · U)se · W)ear · X)it · Y)ell · Z)tats · Space: pass

In dungeons: Up/Down to advance/retreat, Left/Right to turn.

Interface: F1 help · F2 inventory · F3 world map · F10 options · F12 debug (with `?debug` or the debug option).
Language, font, tile pack and controls are in the options (saved in `config.json`). In dev, `?lang=fr`,
`?pack=<name>` and `?debug` override them for the session.

## iPad / touch

The game can be played with a mouse or a touch screen; every tap is turned into the original keys.

- Overworld and towns: tap a square to walk there (step by step; any key, a prompt or a fight stops
  the walk). Tap a neighbour (townsperson, monster) for Talk / Attack / Look, a door for Open /
  Jimmy, the party for what is under it (Get chest, Klimb, Descend, Enter, Board, X-it).
- Dungeons: swipe up/down to advance/retreat, left/right to turn; tap for the dungeon commands.
- Combat: tap a foe next to the active member to attack it, any other square to step towards it.
- The command bar gives the other commands and a text field for conversations. Walking by tapping
  can be turned off in the settings (`controls.tapToMove`).

On an iPad, build the game (`npm run build`, with the extracted files) and serve `dist/` from a
machine on the same network (`npx vite preview --host`); service workers and installation need
HTTPS (or localhost). In Safari: Share > Add to Home Screen. The game then starts full screen and
keeps its files in the cache after the first visit.

## Status

Implemented: intro and character creation, overworld (moons, moongates, wind, ships, horses,
wandering monsters), towns (NPCs, line of sight, doors, conversations, all shops, inns, healers,
Lord British, Hawkwind, companions), tactical combat, 3D dungeons (rooms, altars, stones), spells and
mixing, items, shrines and meditation, and the endgame (Abyss, Codex).

Some details are interpretations rather than exact ports (timings that depended on CPU speed in the
original, the 3D look of the dungeons); they are marked in the source.

Added in this port: English and French (texts of the original game translated locally from the
extracted files, see `docs/TRANSLATING.md`), interchangeable tile packs (HD packs can be generated with
`tools/packs`), HTML interface (command bar, inventory, world map, help, options, debug panel), mouse and
touch play (tap to walk, context menus, swipes) and an installable web app. The conversation layer is
ready for an LLM provider (`src/game/conversation`), not enabled yet.

Hole up and saving inside dungeons (DNGMAP.SAV) are implemented, and the spells and items that had never been
played (Blink, Gate, Winds, Dispell, Energy, Open, cannons, New Order, telescope, altars, Abyss, Codex) were
play-tested against the original routines; the debug panel (F12) prepares each of them.
