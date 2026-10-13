// PixelLab sample for art direction B ("2026" redesign, see docs/PIXELLAB.md): a coherent terrain set and
// transparent sprites, composed into a mock 11x11 world view, before committing to a whole pack.
//
//   node tools/packs/pixellab-sample.mjs terrain [seed]     terrain set (create-tiles-pro)
//   node tools/packs/pixellab-sample.mjs sprite <name>      64 candidates of one sprite (generate-image-v2)
//   node tools/packs/pixellab-sample.mjs headless [seed]    headless brute: inpainted stump + idle animation
//
// Raw responses and images go to test-output/pixellab/sample/ (local).
import fs from "node:fs";
import path from "node:path";
import { b64, call, save, waitJob } from "./pixellab.mjs";
import { transitionMasks } from "./pixellab-mask.mjs";

const OUT = path.resolve("test-output/pixellab/sample");
const SIZE = 32;

const STYLE = "modern high quality pixel art, vibrant natural colors, soft shading, cohesive palette, like Stardew Valley or Eastward";

/** Terrain set, in SHAPES.EGA order (tiles 0-8). */
export const TERRAIN = [
  [0, "deep dark blue ocean water with subtle waves"],
  [1, "blue sea water with small wave highlights"],
  [2, "shallow turquoise water over sand"],
  [3, "murky green swamp with mud puddles and reeds"],
  [4, "lush green grass meadow"],
  [5, "grass with low green bushes and shrubs"],
  [6, "dense forest of round tree crowns seen from above"],
  [7, "green rolling hills with small mounds"],
  [8, "grey rocky mountain peaks with snow"],
];

async function job(route, body, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await call("POST", route, body);
  const id = r.background_job_id;
  const done = id ? await waitJob(id) : r;
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(done, (k, v) => (typeof v === "string" && v.length > 300 ? `<${v.length} chars>` : v), 1));
  return done;
}

/** Every base64 image found anywhere in a response, in order. */
function images(o, acc = []) {
  if (!o || typeof o !== "object") return acc;
  if (typeof o.base64 === "string") { acc.push(o); return acc; }
  for (const v of Object.values(o)) images(v, acc);
  return acc;
}

/**
 * Characters, created in the PixelLab library (create-character-v3) so they can be animated in the PixelLab
 * UI: 4-frame idle loop, south-facing (the game never turns creatures).
 */
export const CHARACTERS = {
  avatar: "young hero adventurer, brown leather hat, green tunic, red trousers, round white shield with a red cross, short sword",
  orc: "green orc warrior with small red horns, crude leather armour, wooden club",
  guard: "town guard in grey plate armour with a steel helmet and a long spear",
  // party classes (0x20-0x2F)
  mage: "wizard in a long blue robe and pointed hat, holding a wooden staff with a glowing crystal",
  bard: "travelling bard in a feathered cap and colourful doublet, holding a lute",
  fighter: "sturdy warrior in chainmail with a round shield and a broadsword",
  druid: "druid in a green hooded robe with a wooden staff wrapped in leaves",
  tinker: "tinker craftsman with goggles, leather apron and a hammer",
  paladin: "paladin knight in shining silver plate armour with a white cape and a sword",
  ranger: "ranger in a green hooded cloak with a longbow",
  shepherd: "humble shepherd in a brown tunic with a crook staff",
  // townsfolk (0x50-0x5F)
  merchant: "town merchant in a fine red coat with a coin purse",
  minstrel: "singing minstrel playing a lute, mouth open singing, colourful clothes",
  jester: "court jester in a red and yellow motley costume with a belled hat",
  beggar: "ragged beggar in torn grey clothes holding out a bowl",
  child: "small village child in simple clothes",
  bull: "brown bull with large horns, four legs, standing",
  king: "wise old king with a white beard, golden crown, royal red and purple robe and sceptre",
  // sea creatures (0x84-0x8F)
  nixie: "nixie water sprite with blue skin and seaweed hair holding a trident",
  squid: "giant purple squid with long tentacles",
  seaserpent: "sea serpent with a long green scaly neck rising from the water",
  seahorse: "giant blue seahorse monster",
  whirlpool: "swirling blue whirlpool vortex of water",
  twister: "grey tornado twister funnel of wind and dust",
  // land monsters (0x90-0xFF)
  rat: "giant brown rat with red eyes, four legs",
  bat: "giant black bat with spread wings",
  spider: "giant black spider with red markings",
  ghost: "pale translucent white ghost floating",
  slime: "green gelatinous slime blob",
  troll: "large grey-green troll with a club",
  gremlin: "small mischievous gremlin with big ears",
  mimic: "treasure chest monster with sharp teeth and a tongue",
  reaper: "twisted dead tree monster with grasping branches and a face",
  insects: "swarm of buzzing giant insects",
  gazer: "floating eye monster with one big eye and eye stalks",
  phantom: "dark hooded phantom spirit with glowing eyes",
  skeleton: "skeleton warrior with a rusty sword and shield",
  rogue: "rogue thief in a dark hooded cloak with a dagger",
  python: "large green python snake coiled",
  ettin: "two-headed giant ettin with a club",
  headless: "blemmye, a headless brute: flat shoulders with no head and no neck, its eyes and mouth are on its broad chest, holding an axe",
  cyclops: "one-eyed cyclops giant with a club",
  wisp: "will-o-the-wisp: a small floating flame orb of pale blue light with a faint trail, a spirit, not a person, no body, no human",
  evilmage: "evil sorcerer in a dark red robe casting a spell",
  liche: "undead liche sorcerer, skeletal face, dark robe, glowing staff",
  lavalizard: "red lava lizard with glowing orange scales",
  zorn: "zorn, a strange purple blob creature with three legs and many eyes",
  daemon: "red winged daemon with horns and a trident",
  hydra: "multi-headed green hydra",
  dragon: "green dragon with spread wings",
  balron: "huge black and red winged balron demon wreathed in flames with a whip",
};
/** Quadrupeds animated with an animal skeleton in the PixelLab UI (default: mannequin). */
const TEMPLATE = { bull: "horse", rat: "cat" };

/**
 * Map places and objects drawn over the terrain (transparent background), 64 candidates each. A string is a
 * world map place; an object gives `desc`, the contact sheet `ground` (GROUNDS key), `suffix` (replaces
 * "overworld map icon") and `ref` (name of a picked sprite given as subject reference: same object, another view).
 */
const OBJ = "game object, low top-down view";
export const SPRITES = {
  town: "small walled medieval town seen from above, stone wall ring, red tiled roofs, gate",
  castle: "small white stone castle seen from above, four corner towers, blue roofs, red flags, gate",
  shrine: "small circle of white standing stones with a glowing ankh in the middle, seen from above",
  dungeon: "dark cave entrance in a grey rock mound with a wooden frame, seen from above",
  // transports (0x10-0x13 ship, 0x80-0x83 pirate ship, 0x14/0x15 horse, 0x18 balloon); W is drawn, E mirrored
  ship: { desc: "wooden sailing ship with white square sails and a small red pennant, side view, the bow points to the left, sailing to the left, no water", ground: "sea", suffix: OBJ },
  "ship-n": { desc: "the same wooden sailing ship seen from behind, sailing away from the viewer, stern in front, white square sails seen from the back, no water", ground: "sea", suffix: OBJ, ref: "ship" },
  "ship-s": { desc: "the same wooden sailing ship seen from the front, sailing toward the viewer, bow in front, white square sails seen from the front, no water", ground: "sea", suffix: OBJ, ref: "ship" },
  pirate: { desc: "pirate sailing ship with black tattered sails and a black flag, dark wooden hull, side view, the bow points to the left, sailing to the left, no water", ground: "sea", suffix: OBJ },
  "pirate-n": { desc: "the same pirate ship seen from behind, sailing away from the viewer, stern in front, black sails seen from the back, no water", ground: "sea", suffix: OBJ, ref: "pirate" },
  "pirate-s": { desc: "the same pirate ship seen from the front, sailing toward the viewer, bow in front, black sails seen from the front, no water", ground: "sea", suffix: OBJ, ref: "pirate" },
  horse: { desc: "brown horse with a black mane and a leather saddle, standing, side view facing left, four legs, no rider", ground: "grass", suffix: OBJ },
  balloon: { desc: "hot-air balloon with a red and yellow striped envelope and a wicker basket, floating", ground: "grass", suffix: OBJ },
  // world map places
  village: "small hamlet of three tiny cottages with red tiled roofs seen from above, no wall",
  ruins: "crumbled ruins of a small stone building seen from above, broken grey walls and fallen stones",
  bridge: { desc: "short wooden plank bridge seen from straight above, spanning from the left edge to the right edge of the image, planks running vertically, wooden railings along its top and bottom sides", ground: "shallows", suffix: "top-down game tile" },
  moongate: { desc: "moongate: a tall upright arch of shimmering glowing blue magical light, a portal, standing on the ground, blue glow", ground: "grass", suffix: OBJ },
  // objects on town, combat and dungeon floors
  ankh: { desc: "white marble ankh statue on a small stone base", ground: "brick", suffix: OBJ },
  campfire: { desc: "campfire: burning logs with orange flames inside a ring of grey stones", ground: "grass", suffix: OBJ },
  chest: { desc: "closed wooden treasure chest with gold metal bands and a lock", ground: "brick", suffix: OBJ },
  // seed 1 ("fallen dead adventurer lying face down on the ground, still, cloak spread") read as crouching
  // figures; seed 2 uses this description
  corpse: { desc: "remains of a dead adventurer lying flat on the ground seen from above: skull, scattered bones and a torn cloak", ground: "brick", suffix: "game object, top-down view" },
  rocks: { desc: "small pile of three grey boulders", ground: "grass", suffix: OBJ },
  column: { desc: "round white marble column pillar, thick, standing", ground: "brick", suffix: OBJ },
  altar: { desc: "stone altar table covered with a red cloth, two lit candles", ground: "brick", suffix: OBJ },
  "ladder-up": { desc: "wooden ladder standing upright, leaning up toward a bright opening above", ground: "dungeon", suffix: OBJ },
  "ladder-down": { desc: "top of a wooden ladder going down into a dark square hole in the floor", ground: "dungeon", suffix: OBJ },
};
/** Contact sheet grounds: picked terrain or tile files (relative to OUT). */
const GROUNDS = { grass: "terrain-1/8.png", sea: "tileset-deep/1111.png", shallows: "tileset-shallows/1111.png", brick: "tiles-paving-1/5.png", dungeon: "tiles-floors-1/4.png" };

/**
 * Opaque full-cell tiles (towns, combat and dungeon rooms), one create-tiles-pro call per set so a set shares
 * its palette: `tiles <set> [seed]` -> tiles-<set>-<seed>/<i>.png.
 */
export const TILESETS = {
  floors: [
    "grey cobblestone brick floor paving, small rectangular bricks",
    "wooden plank floor, horizontal planks",
    "dark dungeon floor of large worn flagstones",
    "solid wall of red brick blocks seen from above",
    "solid dark grey bedrock, impassable rock",
    "rubble: broken stones and gravel over packed earth",
    "closed wooden door with iron hinges in a red brick wall",
    "closed wooden door with a heavy iron lock and iron bands in a red brick wall",
  ],
  // town street floor alternatives (floors-1/0, grey bricks, looked too much like a wall)
  paving: [
    "warm beige stone paving of small square flagstones, town street floor",
    "sandy cobblestone street, rounded light stones",
    "pale grey herringbone brick pavement, town square floor",
    "light terracotta tiled floor, square tiles with thin grout",
  ],
  fields: [
    "bubbling molten lava with glowing orange cracks",
    "poison field: swirling toxic green mist",
    "energy field: crackling blue lightning energy",
    "fire field: roaring red and orange flames",
    "sleep field: shimmering magenta and purple magic sparkles",
  ],
};

/** Style reference for every sprite: the Avatar (outline, detail and shading, not its colours). */
function styleRef() {
  const f = path.join(OUT, "character-avatar-south.png");
  return { image: b64(f), size: { width: SIZE, height: SIZE } };
}

/** 64 candidates in an 8x8 grid, each over a terrain tile, zoomed: picks are made by grid index. */
async function contactSheet(dir, out, groundFile) {
  const { PNG } = await import("pngjs");
  const files = fs.readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  const ground = groundFile && fs.existsSync(groundFile) ? PNG.sync.read(fs.readFileSync(groundFile)) : null;
  const Z = 3, C = SIZE * Z + 4, sheet = new PNG({ width: 8 * C, height: Math.ceil(files.length / 8) * C });
  sheet.data.fill(30);
  files.forEach((f, i) => {
    const img = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
    const x0 = (i % 8) * C + 2, y0 = Math.floor(i / 8) * C + 2;
    for (let y = 0; y < SIZE * Z; y++) for (let x = 0; x < SIZE * Z; x++) {
      const sx = Math.floor(x / Z), sy = Math.floor(y / Z), d = ((y0 + y) * sheet.width + x0 + x) * 4;
      const g = ground ? (sy % ground.height * ground.width + sx % ground.width) * 4 : -1;
      const s = sx < img.width && sy < img.height ? (sy * img.width + sx) * 4 : -1, a = s >= 0 ? img.data[s + 3] / 255 : 0;
      for (let c = 0; c < 3; c++) sheet.data[d + c] = (s >= 0 ? img.data[s + c] : 0) * a + (g >= 0 ? ground.data[g + c] : 80) * (1 - a);
      sheet.data[d + 3] = 255;
    }
  });
  fs.writeFileSync(out, PNG.sync.write(sheet));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "sprite") {
  // `sprite <name> [seed]`: seed 1 writes sprite-<name>/, another seed sprite-<name>-<seed>/
  const seed = Number(process.argv[4] ?? 1);
  const name = `sprite-${arg}${seed === 1 ? "" : `-${seed}`}`;
  const s = typeof SPRITES[arg] === "string" ? { desc: SPRITES[arg] } : SPRITES[arg];
  const picks = JSON.parse(fs.readFileSync(path.resolve("tools/packs/pixellab-picks.json"), "utf8"));
  const r = await job("/generate-image-v2", {
    description: `${s.desc}, ${s.suffix ?? "overworld map icon"}, ${STYLE}`,
    image_size: { width: SIZE, height: SIZE },
    no_background: true,
    style_image: styleRef(),
    style_options: { color_palette: false, outline: true, detail: true, shading: true },
    ...(s.ref ? { reference_images: [{ image: b64(pickedSprite(picks, s.ref)), size: { width: SIZE, height: SIZE } }] } : {}),
    seed,
  }, name);
  const imgs = images(r.last_response ?? r);
  imgs.forEach((img, i) => save(img, path.join(OUT, name, `${i}.png`)));
  await contactSheet(path.join(OUT, name), path.join(OUT, `${name}-sheet.png`), path.join(OUT, GROUNDS[s.ground ?? "grass"]));
  console.log(`${name}: ${imgs.length} candidates; usage ${JSON.stringify(r.usage)}`);
}
/** File of a picked sprite: picks.sprites[name] is a candidate index, or "<dir suffix>/<index>" for another seed. */
function pickedSprite(picks, name) {
  const p = String(picks.sprites[name]), [dir, i] = p.includes("/") ? p.split("/") : ["", p];
  return path.join(OUT, `sprite-${name}${dir ? `-${dir}` : ""}`, `${i}.png`);
}
if (cmd === "tiles") {
  const seed = Number(process.argv[4] ?? 1);
  const name = `tiles-${arg}-${seed}`;
  const r = await job("/create-tiles-pro", {
    description: TILESETS[arg].map((d, i) => `${i + 1}). ${d}`).join(" ") + `. Seamless tileable top-down tiles filling the whole square edge to edge, for a town and dungeon map, ${STYLE}`,
    tile_type: "square_topdown",
    tile_size: SIZE,
    tile_view: "top-down",
    outline_mode: "segmentation",
    seed,
  }, name);
  const tiles = await call("GET", `/tiles-pro/${r.last_response.tile_id}`);
  const urls = Object.entries(tiles.storage_urls ?? {});
  fs.mkdirSync(path.join(OUT, name), { recursive: true });
  for (const [key, url] of urls) fs.writeFileSync(path.join(OUT, name, `${key.replace("tile_", "")}.png`), Buffer.from(await (await fetch(url)).arrayBuffer()));
  await tileSheet(path.join(OUT, name), path.join(OUT, `${name}-sheet.png`));
  console.log(`${name}: ${urls.length} tiles; usage ${JSON.stringify(r.usage)}`);
}
/** Each tile 3x3 (seams), zoomed 2x, 4 per row, labelled by position. */
async function tileSheet(dir, out) {
  const { PNG } = await import("pngjs");
  const files = fs.readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  const Z = 2, C = 3 * SIZE * Z + 8, sheet = new PNG({ width: 4 * C, height: Math.ceil(files.length / 4) * C });
  sheet.data.fill(200);
  files.forEach((f, i) => {
    const img = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
    const x0 = (i % 4) * C + 4, y0 = Math.floor(i / 4) * C + 4;
    for (let y = 0; y < 3 * SIZE * Z; y++) for (let x = 0; x < 3 * SIZE * Z; x++) {
      const s = ((Math.floor(y / Z) % img.height) * img.width + Math.floor(x / Z) % img.width) * 4, d = ((y0 + y) * sheet.width + x0 + x) * 4;
      img.data.copy(sheet.data, d, s, s + 3); sheet.data[d + 3] = 255;
    }
  });
  fs.writeFileSync(out, PNG.sync.write(sheet));
}
// `characters`: every character not created yet (a south view on disk means done)
const todo = cmd === "characters" ? Object.keys(CHARACTERS).filter((k) => !fs.existsSync(path.join(OUT, `character-${k}-south.png`)))
  : cmd === "character" ? [arg] : [];
for (const arg of todo) try {
  const r = await job("/create-character-v3", {
    description: `${CHARACTERS[arg]}, full body, ${STYLE}`,
    name: `U4 ${arg}`,
    image_size: { width: SIZE, height: SIZE },
    view: "low top-down",
    no_background: true,
    outline: "single color black outline",
    detail: "medium detail",
    ...(TEMPLATE[arg] ? { template_id: TEMPLATE[arg] } : {}),
    seed: 1,
  }, `character-${arg}`);
  const res = r.last_response ?? r;
  fs.writeFileSync(path.join(OUT, `character-${arg}-south.png`), Buffer.from(await (await fetch(res.storage_urls.south)).arrayBuffer()));
  console.log(`character ${arg}: id ${res.character_id}`);
} catch (e) { console.log(`character ${arg}: ${e.message}`); }
if (cmd === "terrain") {
  const seed = Number(arg ?? 1);
  const name = `terrain-${seed}`;
  const r = await job("/create-tiles-pro", {
    description: TERRAIN.map(([, d], i) => `${i + 1}). ${d}`).join(" ") + `. Seamless top-down overworld terrain tiles, ${STYLE}`,
    tile_type: "square_topdown",
    tile_size: SIZE,
    tile_view: "top-down",
    outline_mode: "segmentation",
    seed,
  }, name);
  // the job only holds metadata: the tiles are behind GET /tiles-pro/{id} as storage URLs
  const tiles = await call("GET", `/tiles-pro/${r.last_response.tile_id}`);
  const urls = Object.entries(tiles.storage_urls ?? {});
  fs.mkdirSync(path.join(OUT, name), { recursive: true });
  for (const [key, url] of urls) fs.writeFileSync(path.join(OUT, name, `${key.replace("tile_", "")}.png`), Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log(`${name}: ${urls.length} tiles; usage ${JSON.stringify(r.usage)}`);
}
/**
 * Wang corner transitions, "upper" terrain over "lower" terrain (SHAPES.EGA ids). The lower part is made
 * transparent afterwards so the sets stack in layers (water, then land, then forest...) and the water layer
 * underneath can be animated.
 */
export const TRANSITIONS = {
  coast: { lower: 1, upper: 4, transition: "light sand beach with white foam at the waterline" },
  deep: { lower: 0, upper: 1 },
  shallows: { lower: 1, upper: 2 },
  scrub: { lower: 4, upper: 5, flat: true },
  forest: { lower: 4, upper: 6, transition: "forest edge with a few small bushes" },
  hills: { lower: 4, upper: 7, flat: true },
  mountains: { lower: 4, upper: 8, transition: "rocky foothills with loose stones" },
  swamp: { lower: 4, upper: 3, transition: "muddy wet ground", flat: true },
};
const terrainDesc = (t) => TERRAIN.find(([id]) => id === t)[1];

if (cmd === "tileset") {
  const picks = JSON.parse(fs.readFileSync(path.join(OUT, "picks.json"), "utf8"));
  const ref = (t) => b64(path.join(OUT, "terrain-1", `${picks.terrain[t]}.png`));
  const mode = process.argv[4] ?? "standard";
  for (const key of arg === "all" ? Object.keys(TRANSITIONS) : [arg]) try {
    const name = `tileset-${key}${mode === "pro" ? "-pro" : ""}`;
    if (fs.existsSync(path.join(OUT, name, "tiles.json"))) continue;
    const t = TRANSITIONS[key];
    const r = await job("/create-tileset", {
      lower_description: terrainDesc(t.lower),
      upper_description: terrainDesc(t.upper),
      transition_description: t.transition ?? "",
      tile_size: { width: SIZE, height: SIZE },
      mode,
      view: "high top-down",
      // flat sets: no raised edge (scrub, hills, swamp lie on the same level as the grass)
      transition_size: t.flat ? 0 : 0.25,
      lower_reference_image: ref(t.lower),
      upper_reference_image: ref(t.upper),
      seed: 1,
    }, name);
    const id = r.last_response?.tileset_id ?? r.tileset_id ?? r.last_response?.id;
    const ts = await call("GET", `/tilesets/${id}`);
    const tiles = ts.tileset?.tiles ?? ts.tiles;
    const dir = path.join(OUT, name);
    fs.mkdirSync(dir, { recursive: true });
    const index = tiles.map((tile) => {
      // file name = corners NW NE SW SE, 0 lower / 1 upper
      const c = ["NW", "NE", "SW", "SE"].map((k) => (tile.corners[k] === "upper" ? 1 : 0)).join("");
      save(tile.image, path.join(dir, `${c}.png`));
      return { corners: c, pattern: tile.pattern_4x4 };
    });
    fs.writeFileSync(path.join(dir, "tiles.json"), JSON.stringify({ key, ...t, mode, tiles: index }, null, 1));
    console.log(`${name}: ${tiles.length} tiles; usage ${JSON.stringify(r.usage)}`);
  } catch (e) { console.log(`tileset ${key}: ${e.message}`); }
}

/**
 * Idle animations, as made by hand in the PixelLab UI ("Free motion", V3, Idle = "idle breathing", 8 frames,
 * south): `animate <name>` or `animate all` (every created character without anim/<name>/). An animation
 * already made in the UI is downloaded instead of generated again. Frames go to anim/<name>/1.png ..
 */
async function downloadIdle(name, id) {
  const ch = await call("GET", `/characters/${id}`);
  const anim = (ch.animations ?? []).find((a) => /idle/i.test(a.animation_type ?? a.display_name ?? ""));
  const south = anim?.directions?.find((d) => d.direction === "south");
  if (!south?.frames?.length) return false;
  const dir = path.join(OUT, "anim", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, url] of south.frames.entries()) fs.writeFileSync(path.join(dir, `${i + 1}.png`), Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log(`animation ${name}: ${south.frames.length} frames (${anim.animation_type})`);
  return true;
}
if (cmd === "animate") {
  const names = arg === "all" ? Object.keys(CHARACTERS) : [arg];
  for (const name of names) try {
    if (fs.existsSync(path.join(OUT, "anim", name))) continue;
    const file = path.join(OUT, `character-${name}.json`);
    if (!fs.existsSync(file)) continue; // not created yet
    const id = (fs.readFileSync(file, "utf8").match(/"character_id": "([^"]+)"/) ?? [])[1];
    if (await downloadIdle(name, id)) continue;
    const r = await call("POST", "/characters/animations", {
      character_id: id, mode: "v3", action_description: "idle breathing", frame_count: 8, directions: ["south"], keep_first_frame: false,
    });
    const jobs = r.background_job_ids ?? (r.background_job_id ? [r.background_job_id] : []);
    for (const j of jobs) await waitJob(j);
    if (!(await downloadIdle(name, id))) console.log(`animation ${name}: no frames after the job (${JSON.stringify(r).slice(0, 300)})`);
  } catch (e) { console.log(`animation ${name}: ${e.message}`); }
}

/**
 * `headless [seed]`: create-character-v3 always draws a head, whatever the description. The head of a generated
 * brute (headless-base.png, the first "headless" character) is erased and only the neck area is inpainted as a
 * stump, so the model has no room for a head; the result is animated from that frame (animate-with-text-v3,
 * drift correction on every frame, otherwise the stump grows back into a head). About 11 generations.
 */
if (cmd === "headless") {
  const { PNG } = await import("pngjs");
  const seed = Number(arg ?? 2);
  const im = PNG.sync.read(fs.readFileSync(path.join(OUT, "headless-base.png")));
  for (let y = 0; y <= 7; y++) for (let x = 11; x <= 20; x++) if (y < 7 || (x >= 13 && x <= 18)) im.data[(y * SIZE + x) * 4 + 3] = 0;
  const mask = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < mask.data.length; i += 4) mask.data.set([0, 0, 0, 255], i);
  for (let y = 6; y <= 9; y++) for (let x = 12; x <= 19; x++) mask.data.set([255, 255, 255, 255], (y * SIZE + x) * 4);
  const sized = (png) => ({ image: b64(PNG.sync.write(png)), size: { width: SIZE, height: SIZE } });
  const r = await job("/inpaint-v3", {
    description: "bloody red neck stump between broad flat shoulders, the head was cut off, nothing above the shoulders",
    inpainting_image: sized(im), mask_image: sized(mask), no_background: true, crop_to_mask: true, seed,
  }, "headless-inpaint");
  const south = path.join(OUT, "character-headless-south.png");
  const inp = r.last_response ?? r;
  save(inp.image ?? inp.images[0], south);
  const a = await job("/animate-with-text-v3", {
    first_frame: b64(south), action: "subtle idle breathing, the shoulders rise and fall slightly, the body stays in place, it has no head",
    frame_count: 8, no_background: true, seed: 2, drift_threshold: 0,
  }, "headless-anim");
  // the first image returned is the reference frame itself
  const frames = (a.last_response ?? a).images.slice(1);
  const dir = path.join(OUT, "anim", "headless");
  fs.rmSync(dir, { recursive: true, force: true });
  frames.forEach((img, i) => save(img, path.join(dir, `${i + 1}.png`)));
  console.log(`headless: ${frames.length} frames`);
}

if (cmd === "scene") await scene();
else console.log(`balance ${JSON.stringify(await call("GET", "/balance"))}`);

/**
 * Mock of the 11x11 world view at (33,221) with the picked assets (test-output/pixellab/sample/picks.json):
 * terrain underneath, places and creatures on top, creatures animated with the frames split from the PixelLab
 * GIFs (anim/<name>/<n>.png). Writes scene-<n>.png per frame; ffmpeg turns them into scene.gif.
 */
async function scene() {
  const { PNG } = await import("pngjs");
  const picks = JSON.parse(fs.readFileSync(path.join(OUT, "picks.json"), "utf8"));
  const world = JSON.parse(fs.readFileSync("assets/original/maps/world.json", "utf8")).tiles;
  const read = (f) => PNG.sync.read(fs.readFileSync(f));
  const terrain = Object.fromEntries(Object.entries(picks.terrain).map(([t, i]) => [t, read(path.join(OUT, "terrain-1", `${i}.png`))]));
  const sprite = (n) => read(path.join(OUT, `sprite-${n}`, `${picks.sprites[n]}.png`));
  // map tile -> [terrain underneath, sprite on top]
  const places = { 9: [8, sprite("dungeon")], 10: [4, sprite("town")], 11: [4, sprite("castle")], 30: [4, sprite("shrine")] };
  const frames = (n) => fs.readdirSync(path.join(OUT, "anim", n)).filter((f) => /^\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b)).map((f) => read(path.join(OUT, "anim", n, f)));
  const X0 = 33, Y0 = 221, N = 11;
  const actors = [[4, 2, frames("avatar")], [1, 1, frames("orc")]];
  // 32 frames: the water scrolls one pixel per frame (a whole tile per loop), creatures loop 4 times
  const count = SIZE;
  const blit = (dst, img, dx, dy) => {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const X = dx + x, Y = dy + y;
      if (X < 0 || Y < 0 || X >= dst.width || Y >= dst.height) continue;
      const s = (y * img.width + x) * 4, d = (Y * dst.width + X) * 4, a = img.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) dst.data[d + c] = img.data[s + c] * a + dst.data[d + c] * (1 - a);
      dst.data[d + 3] = 255;
    }
  };
  // terrain of each map cell, one cell of margin around the view for the half-offset transition tiles
  const cell = (x, y) => { const t = world[(Y0 + y) * 256 + X0 + x]; return places[t]?.[0] ?? t; };
  const layers = terrainLayers(PNG, read, terrain);
  for (let f = 0; f < count; f++) {
    const img = new PNG({ width: N * SIZE, height: N * SIZE });
    // deep water everywhere, scrolled
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) blit(img, scroll(PNG, layers.base, f), x * SIZE, y * SIZE);
    // each layer: dual grid (tiles centred on the corners between 4 cells), lower part transparent. The
    // coast layer records where the land is; the land layers above it (forest, mountains...) are clipped to
    // it, so a transition the mask could not separate (scrub and grass share colours) never covers water.
    const land = new Float32Array(img.width * img.height);
    for (const L of layers.list) for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const c = [cell(i - 1, j - 1), cell(i, j - 1), cell(i - 1, j), cell(i, j)].map((t) => (L.member(t) ? 1 : 0)).join("");
      if (c === "0000") continue;
      const t = L.tile(c, f), x0 = i * SIZE - SIZE / 2, y0 = j * SIZE - SIZE / 2;
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const X = x0 + x, Y = y0 + y;
        if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
        const p = Y * img.width + X;
        if (L.kind === "coast") land[p] = Math.max(land[p], t.data[(y * SIZE + x) * 4 + 3] / 255);
        if (L.kind === "land") t.data[(y * SIZE + x) * 4 + 3] *= land[p];
      }
      blit(img, t, x0, y0);
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const top = places[world[(Y0 + y) * 256 + X0 + x]]?.[1];
      if (top) blit(img, top, x * SIZE, y * SIZE);
    }
    // creature frames are larger than a tile: centred horizontally, feet on the bottom of the square
    for (const [x, y, fr] of actors) { const a = fr[f % fr.length]; blit(img, a, x * SIZE + (SIZE - a.width) / 2, y * SIZE + SIZE - a.height + 4); }
    fs.writeFileSync(path.join(OUT, "scene", `${f + 1}.png`), (fs.mkdirSync(path.join(OUT, "scene"), { recursive: true }), PNG.sync.write(img)));
  }
  console.log(`scene: ${count} frames in ${path.join(OUT, "scene")}`);
}

/** A tileable image shifted by f pixels to the left (water animation). */
function scroll(PNG, img, f) {
  const out = new PNG({ width: img.width, height: img.height });
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const s = (y * img.width + (x + f) % img.width) * 4;
    img.data.copy(out.data, (y * img.width + x) * 4, s, s + 4);
  }
  return out;
}

/**
 * The terrain layers, bottom to top. Each layer draws, for a corner pattern (NW NE SW SE, 1 = cell belongs to
 * the layer), its transition tile with the lower terrain made transparent. Water layers keep only the mask and
 * fill it with their scrolled texture, so the water moves under the coasts. A layer whose set is missing falls
 * back to square quadrants of the picked tile. The masks come from pixellab-mask.mjs.
 */
function terrainLayers(PNG, read, terrain) {
  const LAND = new Set([3, 4, 5, 6, 7, 8]);
  const defs = [
    { set: "deep", t: 1, member: (t) => t !== 0, water: true, kind: "water" },
    { set: "shallows", t: 2, member: (t) => t === 2, water: true, kind: "water" },
    { set: "coast", t: 4, member: (t) => LAND.has(t), kind: "coast" },
    { set: "swamp", t: 3, member: (t) => t === 3, kind: "land" },
    { set: "scrub", t: 5, member: (t) => t === 5, kind: "land" },
    { set: "hills", t: 7, member: (t) => t === 7, kind: "land" },
    { set: "forest", t: 6, member: (t) => t === 6, kind: "land" },
    { set: "mountains", t: 8, member: (t) => t === 8, kind: "land" },
  ];
  const H = SIZE / 2;
  const list = defs.map((d) => {
    const dir = path.join(OUT, `tileset-${d.set}`);
    const has = fs.existsSync(path.join(dir, "tiles.json"));
    const tiles = {};
    if (has) for (const f of fs.readdirSync(dir).filter((f) => /^[01]{4}\.png$/.test(f))) tiles[f.slice(0, 4)] = read(path.join(dir, f));
    const full = has ? tiles["1111"] : terrain[d.t];
    const mask = transitionMasks(has ? tiles : null, SIZE);
    const tile = (c, f) => {
      const src = d.water ? scroll(PNG, full, f) : has ? tiles[c] : full, m = mask(c);
      const out = new PNG({ width: SIZE, height: SIZE });
      for (let p = 0; p < SIZE * SIZE; p++) {
        // without a set, the picked tile is aligned on the map grid: shift it by half a tile
        const q = has ? p : (((p / SIZE | 0) + H) % SIZE) * SIZE + ((p % SIZE) + H) % SIZE;
        src.data.copy(out.data, p * 4, q * 4, q * 4 + 3);
        out.data[p * 4 + 3] = m[p] * 255;
      }
      return out;
    };
    return { member: d.member, kind: d.kind, tile, has: has ? d.set : null };
  });
  const deep = fs.existsSync(path.join(OUT, "tileset-deep", "0000.png")) ? read(path.join(OUT, "tileset-deep", "0000.png")) : terrain[0];
  console.log(`layers with transitions: ${list.filter((l) => l.has).map((l) => l.has).join(", ")}`);
  return { base: deep, list };
}
