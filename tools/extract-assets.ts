// Extracts everything the engine needs from an original Ultima IV (DOS/GOG) install into modern
// formats under assets/original/. The engine never reads the original files: run this once.
//
//   npm run extract -- [--game-dir <dir>] [--out <dir>] [--no-packs]
//
// Default game dir: $U4_GAME_DIR or the GOG Galaxy location. The maps, dialogues and texts it writes are
// committed with the project (the game runs without an install); the original graphics (tiles/, font/,
// screens/), manifest.json and the install's PARTY.SAV are git-ignored and never deployed (.gitignore,
// vite.config.ts). Into assets/original/, it then builds the tile packs derived from the original tiles
// (tools/packs/upscale.ts, assets/packs/*-derived/, git-ignored too) unless --no-packs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { decodeCharset, decodeScreen, decodeTiles, EGA_PALETTE } from "../src/formats/ega";
import { decodeCombat, decodeDungeon, decodeTown, decodeWorld } from "../src/formats/maps";
import { decodeTalk } from "../src/formats/tlk";
import { decodeSave } from "../src/formats/save";
import { textSpecs, type TextSpec } from "../src/data/text";
import "../src/data/all-texts";
import { avatarSegment, titleSegment, type DataSegment } from "./exe/image";
import { encodeIndexed } from "./extract/png";
import { TITLE_DATA } from "./extract/title-data";

export const EXTRACT_VERSION = 1;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface ExtractOptions { gameDir: string; outDir: string; log?: (s: string) => void }

export function extractAll({ gameDir, outDir, log = console.log }: ExtractOptions): void {
  const read = (f: string) => new Uint8Array(fs.readFileSync(path.join(gameDir, f)));
  const files = fs.readdirSync(gameDir);
  const byExt = (ext: string) => files.filter((f) => f.toUpperCase().endsWith(ext)).map((f) => f.toUpperCase()).sort();
  const written: string[] = [];
  const write = (rel: string, data: string | Uint8Array) => {
    const file = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    written.push(rel.replace(/\\/g, "/"));
  };
  const json = (rel: string, v: unknown) => write(rel, JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? Array.from(x) : x)));
  const base = (f: string) => f.replace(/\.[^.]+$/, "").toLowerCase();

  const avatar = avatarSegment(read("AVATAR.EXE"));
  const title = titleSegment(read("TITLE.EXE"));

  // --- texts (AVATAR.EXE + TITLE.EXE), by key
  const seg = (s: TextSpec & { src: string }): DataSegment => (s.src === "title" ? title : avatar);
  const game: Record<string, string | string[]> = {};
  for (const [key, spec] of textSpecs()) {
    if (spec.kind === "str") game[key] = seg(spec).str(spec.ds);
    else if (spec.kind === "ptrs") game[key] = seg(spec).ptrs(spec.ds, spec.count);
  }
  json("i18n/en/game.json", game);
  log(`texts: ${Object.keys(game).length} keys`);

  // --- tiles (original 16x16 pack), font, full-screen pictures
  const tiles = decodeTiles(read("SHAPES.EGA"));
  const atlas = new Uint8Array(256 * 256);
  tiles.forEach((t, i) => {
    const ox = (i % 16) * 16, oy = (i >> 4) * 16;
    for (let y = 0; y < 16; y++) atlas.set(t.pixels.subarray(y * 16, y * 16 + 16), (oy + y) * 256 + ox);
  });
  write("tiles/original/tiles.png", encodeIndexed(256, 256, atlas, EGA_PALETTE));
  json("tiles/original/pack.json", {
    name: "Original (EGA)", tileSize: 16, columns: 16, count: 256, image: "tiles.png", indexed: true,
    // Animations of the original renderer (src/render/renderer.ts animateTiles): rows scroll down by one
    // pixel per tick for water/fields/lava; the other animated tiles are frame sequences (monsters).
    animations: [{ kind: "scroll", tiles: [0, 1, 2, 0x44, 0x45, 0x46, 0x47, 0x4c] }],
  });

  const glyphs = decodeCharset(read("CHARSET.EGA"));
  const cols = 16, rows = Math.ceil(glyphs.length / cols);
  const font = new Uint8Array(cols * 8 * rows * 8);
  glyphs.forEach((g, i) => {
    const ox = (i % cols) * 8, oy = Math.floor(i / cols) * 8;
    for (let y = 0; y < 8; y++) font.set(g.pixels.subarray(y * 8, y * 8 + 8), (oy + y) * cols * 8 + ox);
  });
  write("font/charset.png", encodeIndexed(cols * 8, rows * 8, font, EGA_PALETTE));
  json("font/charset.json", { glyphWidth: 8, glyphHeight: 8, columns: cols, count: glyphs.length, image: "charset.png" });

  const screens = byExt(".EGA").filter((f) => !["SHAPES.EGA", "CHARSET.EGA"].includes(f));
  for (const f of screens) {
    const img = decodeScreen(read(f));
    write(`screens/${base(f)}.png`, encodeIndexed(img.width, img.height, img.pixels, EGA_PALETTE));
  }
  log(`pictures: ${screens.length}`);

  // --- maps
  json("maps/world.json", { width: 256, height: 256, tiles: decodeWorld(read("WORLD.MAP")) });
  for (const f of byExt(".ULT")) json(`maps/towns/${base(f)}.json`, decodeTown(read(f)));
  for (const f of byExt(".CON")) {
    if (f === "SHRINE.CON") json("maps/combat/shrine.json", { tiles: read(f).slice(0, 121) });
    else json(`maps/combat/${base(f)}.json`, decodeCombat(read(f)));
  }
  for (const f of byExt(".DNG")) {
    // CAMP.DNG is not a dungeon but the 192-byte arena of a camp underground (same layout as *.CON)
    if (read(f).length <= 192) json(`maps/combat/${base(f)}-dng.json`, decodeCombat(read(f)));
    else json(`maps/dungeons/${base(f)}.json`, decodeDungeon(read(f)));
  }
  for (const f of byExt(".TLK")) json(`talk/${base(f)}.json`, decodeTalk(read(f)));
  log(`maps: ${byExt(".ULT").length} towns, ${byExt(".CON").length} arenas, ${byExt(".DNG").length} dungeons, ${byExt(".TLK").length} dialogues`);

  // --- non-text data of the title program (tables used by the intro routines)
  const td: Record<string, number[]> = {};
  for (const [k, [kind, off, n]] of Object.entries(TITLE_DATA)) td[k] = kind === "bytes" ? Array.from(title.bytes(off, n)) : title.words(off, n);
  json("data/title.json", td);

  // --- starting party
  json("saves/party.new.json", decodeSave(read("PARTY.NEW")));
  // The install's own PARTY.SAV: "Journey Onward" offers it while the port has no save of its own
  // (only if it holds a party), and the dev shortcut ?skipintro starts from it.
  if (files.some((f) => f.toUpperCase() === "PARTY.SAV")) json("saves/party.sav.json", decodeSave(read("PARTY.SAV")));

  // --- manifest
  const hash = (f: string) => crypto.createHash("sha256").update(read(f)).digest("hex");
  const sources = Object.fromEntries(["AVATAR.EXE", "TITLE.EXE", "WORLD.MAP", "SHAPES.EGA"].map((f) => [f, hash(f)]));
  json("manifest.json", { version: EXTRACT_VERSION, extractedAt: new Date().toISOString(), sources, files: [...written].sort() });
  log(`${written.length} files written to ${outDir}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (isMain) {
  const gameDir = arg("--game-dir") ?? process.env.U4_GAME_DIR ?? "C:/Program Files/GOG Galaxy/Games/Ultima 4";
  const outDir = path.resolve(arg("--out") ?? "assets/original");
  if (!fs.existsSync(path.join(gameDir, "AVATAR.EXE"))) {
    console.error(`AVATAR.EXE not found in ${gameDir}; pass --game-dir <Ultima 4 install>`);
    process.exit(1);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  extractAll({ gameDir, outDir });
  if (!process.argv.includes("--no-packs") && outDir === path.resolve("assets/original")) {
    for (const algo of ["scale4x", "scale3x"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "tools/packs/upscale.ts", "--algo", algo], { stdio: "inherit" });
      if (r.status !== 0) { console.error(`tile pack ${algo}-derived failed`); process.exit(1); }
    }
  }
}
