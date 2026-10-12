# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Reimplementation of **Ultima IV: Quest of the Avatar** (GOG DOS release) in TypeScript, rendered with three.js,
shipped as a browser/PWA build and a Tauri v2 desktop app. The engine was rebuilt by reverse-engineering
`AVATAR.EXE` (EXEPACK-packed) and `TITLE.EXE` with Ghidra. `README.md` (and `README.fr.md`) cover features,
keys and touch controls; `docs/RE_NOTES.md` is the reverse-engineering reference.

## Commands

Node is bundled in `.nodeenv` and is not on PATH:

- PowerShell: `$env:Path = "E:\IdeaProjects\u4\.nodeenv\Scripts;" + $env:Path`
- Git Bash: `export PATH="/e/IdeaProjects/u4/.nodeenv/Scripts:$PATH"`

```
npm run extract -- --game-dir "C:\Program Files\GOG Galaxy\Games\Ultima 4"   # one-time; required before running
npm run dev                 # browser only, http://127.0.0.1:1420 (strict port)
npm run tauri dev           # desktop app (needs Rust / MSVC)
npm run build               # tsc --noEmit + vite build
npm run typecheck
npm test                    # Vitest, tests/**/*.test.ts
npx vitest run tests/pathfinding.test.ts      # single file
npx vitest run -t "name of test"              # single test by name
node tools/scenarios.mjs --ref                # record screenshot references (dev server running)
node tools/scenarios.mjs [world town ...]     # compare against references, optionally only some scenarios
npx tsx tools/packs/upscale.ts --algo scale4x # Scale4x tile pack -> assets/packs/scale4x-derived
```

- Tests that need the original game files use `tests/gamedir.ts` (`U4_GAME_DIR`, default GOG path) and are skipped when it is absent.
- Headless tools (`tools/scenarios.mjs`, `tools/ui-shot.mjs`, `tools/page-eval.mjs`, `tools/page-errors.mjs`) drive a local Chrome via puppeteer-core against the running dev server; output goes to `test-output/` (git-ignored, contains original graphics).
- Dev URL flags: `?skipintro` (start on the world map), `?debug` (F12 debug panel), `?lang=fr`, `?pack=<name>`. In dev, `window.__game` exposes the `Game` instance and `window.__toDungeon(id)` jumps to a dungeon entrance; scenarios script the game through these.
- Start Vite and headless runs from the PowerShell tool: the Bash tool is network-sandboxed. Restart Vite with `--force` after installing npm packages.
- Write files containing backslashes (`\n`, `\u0012`, Windows paths) with Write/Edit, not Bash heredocs.

## Original-content rules (important)

- The engine never reads the original binaries. `tools/extract-assets.ts` (EXEPACK unpacker in `tools/exe/`) converts them **once** into `assets/original/` (PNG, JSON maps, dialogues, tables, text catalogs); runtime code reads only that folder through `src/assets/store.ts`, which still names resources by their original file names (`LCB_1.ULT`, `GRASS.CON`...).
- **Never put original game text in source, not even in comments.** Original texts are declared by location only, via `defineTexts` in `src/data/text.ts` (e.g. `talk.youSay: 0x2a62`, a DS offset; `ptrs(ds, n)` for pointer tables). The extractor walks the same registry, so key list and offsets have one source of truth. Texts written for this port use `port()`/`portList()` and live in `src/i18n/game/<lang>/*.json`.
- Git-ignored, derived from the game, must never be committed on public branches: `assets/original/`, `assets/i18n/` (translations of original texts/dialogues), `assets/packs/*-derived/`, `test-output/`.
- Branches: `feature/modernization` is the public working branch. `local/bundled-assets` is local only (never pushed). After switching branches, run `npm run extract`, then `npm run assets:local` to restore local translations/packs.

## Architecture

- `src/main.ts` bootstraps: config → UI language → asset manifest check → game language catalogs → tile pack → `Renderer` → `Game` → DOM shell, panels, pointer input → `installMagic`/`installItems` → rAF loop.
- **Game logic is async and input-driven.** `src/game/input.ts` is a key queue; game code `await`s keys (keyboard, command bar, touch all feed the same original keys). `game.ts` holds state (`save` = PARTY.SAV image), the main loop, movement and screen composition.
- **Command registry** (`src/game/commands.ts`): every key command is registered per context (`world` | `town` | `dungeon` | `combat`) by its module (`actions.ts`, `places.ts`, `transport.ts`, `magic.ts`, `items.ts`, ...). The same list drives the help panel and the command bar; labels come from the UI catalog `cmd.<id>`.
- **Layers** (`src/ui/layers.ts`): the base screen is the original layout (frame, 11×11 viewport, party panel, 16-column console). Modes (combat, dungeon, shops, visions, intro, endgame) `push` a layer providing `view`/`scene3d`/`status`/`draw`/`invert` and `remove()` it in a `finally`. The topmost layer providing a part wins.
- `src/render`: three.js renderer with a 320×200 UI layer (original or Press Start 2P font), tile packs of any tile size (atlas with the original SHAPES.EGA indices), 3D dungeon view in `src/dungeon`.
- `src/ui/dom`: HTML shell over the canvas (command bar, panels, mouse/touch translation to keys); `src/ui/panels`: inventory, world map, help, options, debug. New screens are DOM over the canvas.
- `src/formats`: decoders of the original formats, used by the extractor and tests, not at runtime.
- `src/data/tables.ts`: rule tables; `src/game/rng.ts` reproduces the original generator (seedable, used by scenarios).
- `src/game/conversation`: dialogue providers (TLK-based; an LLM provider exists but is not enabled).
- i18n: UI strings `src/i18n/ui/<lang>/*.json`, port-written game texts `src/i18n/game/<lang>/*.json`, translations of original texts `assets/i18n/<lang>/` (local only). Missing keys fall back to English. Follow `docs/TRANSLATING.md` (control chars, 16-column pre-wrapped texts, 4-letter keyword uniqueness, glossary).
- `src-tauri`: Tauri v2 shell; saves and `config.json` go to the app data dir (browser mode: `localStorage`). Vite ignores `src-tauri/**` because Cargo locks crash the watcher.

## Conventions

- Ported rules, formulas and tables cite the original function (`1000:xxxx`, == unpacked image offset) and data (`DS:xxxx`, == image offset `0xF0D0 + x`) addresses in comments. Keep doing so; add new findings to `docs/RE_NOTES.md`.
- Where the port interprets rather than copies (CPU-speed timings, 3D dungeon look), mark it in the source.
- Line endings are LF (`.gitattributes`).
