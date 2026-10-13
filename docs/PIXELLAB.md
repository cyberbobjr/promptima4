# PixelLab — AI pixel-art generation for the tile packs

Everything learned while evaluating [PixelLab](https://www.pixellab.ai/docs) for an HD tile pack (October 2026),
so the work can be resumed in a later session (with a paid plan). Read the **Next session** section first.

## Context: what was tried before

| Approach | Result |
|---|---|
| Local ComfyUI, Qwen-Image-Edit-2511 + Lightning LoRA, image-to-image per tile (removed from the repo) | **Rejected by the user**: general diffusion output, blurry once reduced to 64 px, shapes lost (castles), and every animation frame drawn independently (moongates, monsters no longer animated consistently). |
| Algorithmic `tools/packs/upscale.ts` (Scale2x/3x/4x = AdvMAME/EPX) | **Current HD pack** (`scale4x-derived`): faithful, original EGA palette, smoothed diagonals, animations intact — but it is the 1987 art, only smoother. |
| PixelLab (this document) | Native pixel art, palette control, animation tools: good for people and monsters; terrain needs a redesign (see below). |

The tile packs format is in `src/assets/store.ts` (`TilePack`): `assets/packs/<name>/pack.json` + an atlas of
16×16 tiles of `tileSize` pixels, same indices as SHAPES.EGA; `animations: [{kind: "scroll", tiles}]` for
water/lava/fields. Packs derived from the original tiles end in `-derived` (git-ignored, local branch only).
Try a pack with `?pack=<name>` in dev, or in Options (F10).

## The API

- Base URL `https://api.pixellab.ai/v2`, header `Authorization: Bearer <token>`.
- References: [OpenAPI](https://api.pixellab.ai/v2/openapi.json) (complete schemas and enums),
  [interactive docs](https://api.pixellab.ai/v2/docs), [llms.txt](https://api.pixellab.ai/v2/llms.txt)
  (endpoint list by area), guides [map tiles](https://www.pixellab.ai/docs/guides/map-tiles) and
  [rotating a character](https://www.pixellab.ai/docs/guides/rotating-a-character). Official JS/Python SDKs
  and an MCP server exist (not used here).
- Token: `PIXELLAB_KEY=...` in `.env` at the project root (git-ignored).
- Client: `tools/packs/pixellab.mjs` — `call(method, route, body)` (reads the token from `.env`, never prints it,
  retries on HTTP 429), `b64(png)` (→ `{type: "base64", base64, format: "png"}`), `save(image, file)`
  (accepts the `data:image/png;base64,` prefix the API returns), `waitJob(id)` (polls
  `GET /background-jobs/{id}`). `node tools/packs/pixellab.mjs balance` prints the credits.

### Quirks found

- **Free/trial plan: one job at a time** — a second request returns HTTP 429 "maximum number of concurrent
  jobs"; the client waits and retries. Generate sequentially.
- **Bitforge and pixflux are synchronous** (the response holds the image); most Pro tools are asynchronous
  (`background_job_id`, then poll `GET /background-jobs/{id}`; statuses `processing`, `completed`, `failed`).
- Responses carry `usage` (`{"type": "generations", "generations": 1}` on the trial, `{"type": "usd"}` on
  credits). `GET /balance` → `{"credits": {...}, "subscription": {"status": "trial", "generations": n, "total": 40}}`.
- `GET /pro-flash/cost` needs `operation` (`create|edit|inpaint|character|object`), `width`, `height`;
  `GET /pro-flash/capabilities` lists sizes (16…128, custom 16–256 step 4). Pro Flash creation ≈ 5 units.
- Pro tools (`*-v2`, `*-pro`, objects, tiles-pro, tilesets pro) cost **20–40 generations** per call;
  bitforge/pixflux cost **1**.
- Enums (exact strings): `outline` = `single color black outline | single color outline | selective outline | lineless`;
  `shading` = `flat shading | basic shading | medium shading | detailed shading | highly detailed shading`;
  `detail` = `low detail | medium detail | highly detailed`; `view` = `side | low top-down | high top-down`;
  `direction` = `north … north-west` (8).
- `init_image_strength` is an integer (default 300; useful range seen: 150–500). Images are PNG base64.

## Endpoints relevant to Ultima IV

| Need | Endpoint | Notes |
|---|---|---|
| Redraw / create one tile (≤ 200×200 area) | `POST /create-image-bitforge` | `description`, `image_size`, `init_image` + `init_image_strength`, `color_image` (**forced palette**), `style_image` + `style_strength` (0–100), `inpainting_image` + `mask_image`, `no_background`, `outline`/`shading`/`detail`/`view`/`direction`, `seed`. Sync, 1 generation. |
| Larger images (32×32–400×400) | `POST /create-image-pixflux` | init image, forced palette, transparent background; no style image. |
| New images in the style of references | `POST /generate-with-style-v2` | 1–4 `style_images`; output size = style size; async. |
| Several terrain/feature tiles at once | `POST /create-tiles-pro` | `tile_type: "square_topdown"`, `tile_view: "top-down"` (or `tile_view_angle`), `tile_size` 16–128, numbered `description` ("1). grass 2). forest …"), `style_images`, `outline_mode: "segmentation"` for cleaner seamless edges, `tile_feature: "tileset"` for a Wang set. Pro. |
| Terrain transitions (coasts…) | `POST /create-tileset` | Wang set (16 tiles, 25 with `transition_size` 1.0) between `lower_description` / `upper_description`; `tile_size` 16/32 (64 in `mode: "pro"`), `view`, per-terrain reference images, `color_image`. Async. |
| Animation from frame 0 | `POST /animate-with-text-v3` (first frame ≤ 256 px + `action`, 4–16 frames, `drift_threshold` colour de-flicker), `POST /interpolation-v2` (first + last frame) | Keeps the design across frames. Pro cost. |
| Same edit on several frames | `POST /edit-images-v2` (`edit_with_text` / `edit_with_reference`, 1–16 images) | Pro. |
| Clean-up | `POST /reduce-colors` (`palette_image` forces several frames onto ONE palette together, optional ordered dithering), `POST /correct-pixelart`, `POST /resize`, `POST /unzoom`, `POST /remove-background` | |
| Objects / map objects | `POST /create-1-direction-object` (16–256 px, `style_images`), `POST /map-objects` | Pro. |

## Experiments and results

Scripts are in `tools/packs/pixellab-experiments/` (they write to `test-output/pixellab/…`, local);
the pilot is `tools/packs/pixellab-pilot.mjs`. All on the trial plan (38 of 40 generations used).

### 1. Init strength (bitforge 64×64, init = original ×4 nearest, EGA palette forced) — `bitforge-strength.mjs`

| Tile | strength 500 | strength 200 |
|---|---|---|
| Castle (0x0B) | identical to the original | redrawn but **distorted** |
| Orc (0xC0) | identical to the original | **good**: same pose and colours, real detail, clean pixels |

The strength is the key setting and depends on the tile category.

### 2. Pilot: 21 tiles + 1 animation frame — `pixellab-pilot.mjs`

Bitforge 64×64, EGA palette forced, `outline: single color black outline`, `shading: basic shading`,
`detail: medium detail`; strength 350 terrain/places, 300 objects, 220 people/monsters; `seed: 1`.
Output: review sheet + test pack `assets/packs/pixellab-derived` (Scale4x for the other tiles).

| Category | Result |
|---|---|
| People (Avatar, mage, guard, king), monsters (orc, skeleton, dragon) | **Convincing**: faithful pose/colours/silhouette, real detail, crisp, readable at game size. |
| Animation (orc frame 2 with frame 1 as `style_image`, `style_strength` 60) | **Consistent** with frame 1. |
| Objects (chest, ankh, ship) | Small gains (the ship). |
| Terrain and places at 350 | Almost unchanged; swamp → grey blocks, forest trunks → yellow. |

The user's verdict on the sheet: "correct, but no more" — not the 2026 look wanted.

### 3. Terrain — `terrain-ega.mjs`, `terrain-modern.mjs`

1. Init = original, **EGA palette forced**, strength 150, `lineless / detailed shading / highly detailed`:
   **failure** (the originals are mostly black: muddy dark textures, grey water, visible seams in 3×3).
2. **Text only, free palette**, same options, description + "top-down game terrain tile, seamless tileable texture
   filling the whole square edge to edge, modern high quality pixel art like Stardew Valley or Eastward, vibrant
   natural colors, soft shading, no border, no frame, no objects": **clearly modern** (lush meadow, great forest
   canopy, calm sea a bit flat); 3×3 tiling shows repetition but no hard seams.
3. In the game, new grass and sea next to old scrub/shallows look like a **patchwork**: terrain must be replaced
   as a whole set.

## Two possible art directions

- **A. Faithful upgrade** (the 1987 tiles, more detailed): EGA palette forced, init image, per-category strength
  (people/monsters ≈ 200–250, objects ≈ 300, places ≈ 300–350), style anchor. Works for creatures; little gain on
  terrain and places. Cheapest (bitforge, ~1 generation per tile).
- **B. Modern redesign ("2026")**: free palette, text-driven, a coherent terrain set (Pro tools), creatures and
  places with transparent backgrounds drawn over the terrain. Needs the engine change below and a paid plan.

## Engine prerequisite for direction B (not done yet)

Today each map square is **one opaque tile**: towns, castles, people, monsters, ships are drawn on black over
nothing. For B:
- two tile layers in `src/render/renderer.ts`: the terrain layer, then the object/creature layer with alpha;
- `src/game/view.ts` (`viewTiles`) returns both: the map tile as terrain, NPCs/objects/party/moongates on top;
  combat arenas and the dungeon rooms likewise;
- in `pack.json`: an `underlay` map `{placeTile: terrainTile}` (e.g. towns/castles/shrines over grass) for map
  tiles that are themselves "objects", and a flag per tile telling whether it has transparency;
- the intro vignette and the dungeon 3D view use the original 16 px tiles: decide whether they follow the pack.

## Tile inventory (SHAPES.EGA, 256 tiles)

- Terrain (≈ 20): 0–8 (seas, shallows, swamp, grass, scrub, forest, hills, mountains), 22 dungeon floor,
  0x31–0x34 shore corners, 0x3E/0x3F floors, 0x44–0x47 fields, 0x4C lava, 0x48 solid, 0x7F wall.
- Places (≈ 12): 9 dungeon, 10 town, 11 castle, 12 village, 13–15 Lord British's castle, 29 ruins, 30 shrine,
  0x40–0x43 moongate (4 frames).
- Transports/objects (≈ 25): ships 16–19, horses 20–21, balloon 24, bridges 23/25/26, ladders 27/28, column,
  ship parts, rocks, corpse, rubble, doors, chest, ankh, altar, campfire, missiles/flashes 0x4D–0x4F.
- People (32): classes 0x20–0x2F (2 frames), townsfolk 0x50–0x5F (2 frames).
- Monsters (128): sea 0x80–0x8F (2 frames), land 0x90–0xFF (36 × 4 frames, but some are 2 + 2).
- Letters 0x60–0x7E (signs): keep as they are (enlarged).

## Proposed pipeline

1. Decide A or B; for B, implement the engine prerequisite first (test it with the Scale4x pack plus a few
   transparent test tiles).
2. **Style anchor**: generate and pick by hand 3–4 key tiles (grass, castle, avatar, orc); use them as
   `style_image` / `style_images` everywhere so the pack shares one look.
3. **Terrain**: B → `create-tiles-pro` with numbered descriptions of the whole set + `create-tileset` for
   grass↔sea coasts; check seams in 3×3 and the vertical seam of the scrolling tiles (water, lava, fields).
4. **Static tiles** (places, objects): bitforge (A: init + strength; B: transparent background).
5. **Animated tiles**: frame 0 first, then the other frames from it (bitforge with frame 0 as `style_image`
   — proven in the pilot — or `animate-with-text-v3` / `interpolation-v2`), then `reduce-colors` on all frames
   together.
6. Review sheet next to the original and Scale4x, regenerate rejects, assemble `assets/packs/<name>-derived/`
   (pack.json + atlas; reuse the assembly code at the end of `pixellab-pilot.mjs`).

## Building the pack

`node tools/packs/build-pixellab.mjs` assembles the layered pack `assets/packs/pixellab/` (format 2,
[TILEPACK-LAYERED.md](TILEPACK-LAYERED.md); versioned, the art is not derived from the original game) from the
generated art in `test-output/pixellab/sample/`, without any API call. The choices (terrain and place candidates)
are read from `tools/packs/pixellab-picks.json` (falls back to `picks.json` in the sample directory). Terrain
layers come from the transition sets `tileset-<key>/` (sea ← deep, shallows, land ← coast, then swamp, scrub,
hills, forest, mountains clipped to the land), the lower terrain made transparent by `pixellab-mask.mjs` (the
same masking as the mock scene of `pixellab-sample.mjs scene`). Sprites: the four picked places, and each
creature found on disk — the animation frames `anim/<name>/1..N.png` if present, else the still
`character-<name>-south.png`; a creature with neither is left out and keeps the classic tile. A creature's `dy`
puts the lowest opaque row of its frames 2 px above the cell bottom (places: 0). The output directory is rebuilt
on each run: re-run it after generating or animating more characters.

Objects and opaque tiles (second batch, October 2026):
- `pixellab-sample.mjs sprite <name> [seed]` covers the `SPRITES` objects too (ships, pirate ships, horse, balloon,
  village, ruins, bridge, moongate, ankh, campfire, chest, corpse, rocks, column, altar, ladders): 64 candidates
  of 32 px, contact sheet over the entry's `ground`. The N/S ship views pass the picked W ship as
  `reference_images` (subject guidance) so the four headings stay the same ship; E is the W view mirrored.
- `pixellab-sample.mjs tiles <set> [seed]` runs `/create-tiles-pro` on a `TILESETS` list (floors and walls,
  town paving, lava and fields) → `tiles-<set>-<seed>/`, with a 3×3 sheet to check the seams.
- Picks: `sprites` (index, or `"<seed>/<index>"`) and `tiles` (`"<set>-<seed>/<index>"`) in `pixellab-picks.json`.
- The build emits one sprite per id (`OBJECTS`: mirrors E headings; moongate phases 0x40–0x43 squash the full
  gate to 1/4…4/4 of its height on the ground line, fading in; the bridge is stretched to the full width, its
  ends 0x19/0x1a are its north/south halves with the deck repeated), sets their `underlay`, writes the `tiles`
  section (`TILES`; the secret door is the wall with a hairline crack; lava and fields `scroll`), maps the
  diagonal shores 0x31–0x34 to shallows in `groundOnly`, and draws the check sheet
  `test-output/pixellab/sample/missing-sheet.png` (sprites over their underlay, tiles 1×1 and 3×3, a corner of
  Britain).
- Cost: ~10 generations per 64-candidate sprite or 16-tile call (the referenced N/S ship calls cost a bit more).

## Cost estimate

A: ≈ 256 bitforge calls + retries ≈ 300–400 generations. B: terrain set and transitions with Pro tools
(several calls at 20–40 each) + ≈ 160 creature/place tiles + animations ≈ 1000+ generations. The trial
(40 generations, one job at a time) is not enough for either: a subscription is needed.

## Next session

1. `node tools/packs/pixellab.mjs balance` (token in `.env`).
2. Read this file, look at `test-output/pixellab/pilot/sheet.png` and `test-output/pixellab/terrain2/sheet.png`
   if they still exist (otherwise re-run the experiment scripts, ~25 generations).
3. Ask the user: direction A or B, tile size (64 recommended), budget.
4. For B, start with the engine prerequisite (two layers + `underlay`), then the terrain set.
