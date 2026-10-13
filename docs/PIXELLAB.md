# PixelLab — the `pixellab` tile pack

The `pixellab` pack (`assets/packs/pixellab/`, versioned) is a full redesign of the game's tiles in modern 32 px
pixel art, generated with [PixelLab](https://www.pixellab.ai/docs) (October 2026). It is a layered pack (format 2,
[TILEPACK-LAYERED.md](TILEPACK-LAYERED.md)): animated water, dual-grid terrain transitions, transparent sprites
over the ground. Its art is not derived from the original game. This file explains how to regenerate or extend
it in the same style.

## History in short

- Local diffusion (ComfyUI, image-to-image per tile): rejected (blurry, shapes lost, animations inconsistent).
- `tools/packs/upscale.ts` (Scale2x/3x/4x): faithful but it is still the 1987 art (`scale4x-derived`, local only).
- PixelLab, faithful upgrade (EGA palette forced, original tile as init image, bitforge): good on creatures, almost
  no gain on terrain; "correct, but no more".
- PixelLab, **modern redesign** (free palette, text-driven, coherent sets, sprites over terrain): the user's choice
  ("j'adore"). Everything below is that direction.

## The API

- Base URL `https://api.pixellab.ai/v2`, header `Authorization: Bearer <token>`.
- References: [OpenAPI](https://api.pixellab.ai/v2/openapi.json) (complete schemas and enums),
  [interactive docs](https://api.pixellab.ai/v2/docs), [llms.txt](https://api.pixellab.ai/v2/llms.txt).
- Token: `PIXELLAB_KEY=...` in `.env` at the project root (git-ignored).
- Client `tools/packs/pixellab.mjs`: `call(method, route, body)` (reads the token from `.env`, never prints it,
  retries on HTTP 429), `b64(png)`, `save(image, file)`, `waitJob(id)` (polls `GET /background-jobs/{id}`).
  `node tools/packs/pixellab.mjs balance` prints the remaining generations.

Quirks:
- **One job at a time**: a second request returns HTTP 429 "maximum number of concurrent jobs"; the client waits
  and retries. Generate sequentially.
- Most tools are asynchronous (`background_job_id`, then poll); responses carry `usage` in generations.
- `create-tiles-pro` only returns metadata: the tiles are behind `GET /tiles-pro/{tile_id}` as storage URLs; the
  same for `create-tileset` (`GET /tilesets/{id}`) and characters (`GET /characters/{id}`).
- `create-character-v3` always draws a head, whatever the description (see `headless` below).
- `animate-with-text-v3` returns the first frame as image 1: drop it.
- Inpainting (`inpaint-v3`): images are `{image: Base64Image, size}`; the mask is white where it generates.

Costs seen (subscription, 2000 generations a month): `generate-image-v2` (64 candidates of 32 px) ≈ 10,
`create-tiles-pro` (up to 16 tiles) ≈ 10, `inpaint-v3` ≈ 10, `animate-with-text-v3` ≈ 1. The whole pack
(terrain, 9 transition sets, 51 animated characters, 27 objects, 7 tile sets) took ≈ 580.

## The style

All in `tools/packs/pixellab-sample.mjs`; keep these to stay consistent:
- `STYLE` suffix on every prompt: "modern high quality pixel art, vibrant natural colors, soft shading, cohesive
  palette, like Stardew Valley or Eastward"; `SIZE = 32`.
- **Terrain** (`TERRAIN`, SHAPES ids 0–8): one `create-tiles-pro` call, `square_topdown`, `outline_mode:
  "segmentation"`. **Transitions** (`TRANSITIONS`): `create-tileset` Wang sets (lower/upper terrain with the
  picked terrain tiles as reference images, `view: "high top-down"`, `transition_size` 0 for flat sets, 0.25
  otherwise); the coast is a sand beach.
- **Characters and monsters** (`CHARACTERS`): `create-character-v3`, `view: "low top-down"`, `single color black
  outline`, `medium detail`, south view, seed 1 (`TEMPLATE`: animal skeletons for the bull and the rat). Idle
  animation: `POST /characters/animations`, mode v3, "idle breathing", 8 frames, south (same as "Free motion" in
  the PixelLab UI; an animation made in the UI is downloaded instead).
- **Places and objects** (`SPRITES`): `generate-image-v2`, transparent background, the Avatar as `style_image`
  (outline, detail, shading; not its colours); 64 candidates, picked by hand. Other views of the same object
  (N/S ships) pass the picked sprite as `reference_images`.
- **Opaque tiles** (`TILESETS`: town and dungeon floors, walls, doors, lava, fields, shallows, ship hull):
  `create-tiles-pro`, one call per set so that a set shares one palette.

## Commands

`node tools/packs/pixellab-sample.mjs <command>` (writes to `test-output/pixellab/sample/`, local):

| Command | Does |
|---|---|
| `terrain [seed]` | terrain set → `terrain-<seed>/` |
| `tileset <key\|all> [standard\|pro]` | transition sets → `tileset-<key>/<NWNESWSE>.png` + `tiles.json` (reads `sample/picks.json`) |
| `characters` / `character <name>` | create the characters not on disk yet → `character-<name>-south.png` + `.json` (id) |
| `animate <name\|all>` | idle animation → `anim/<name>/1..8.png` |
| `headless [seed]` | headless brute: head erased from `headless-base.png`, neck stump inpainted, animated with `drift_threshold: 0` (otherwise the head grows back) |
| `sprite <name> [seed]` | 64 candidates → `sprite-<name>[-<seed>]/` + contact sheet over the entry's ground |
| `tiles <set> [seed]` | opaque tile set → `tiles-<set>-<seed>/` + 3×3 seam sheet |
| `scene` | mock 11×11 world view with the picks (frames + GIF) |

Then pick by hand in `tools/packs/pixellab-picks.json` (`sprites`: index or `"<seed>/<index>"`; `tiles`:
`"<set>-<seed>/<index>"`; `terrain`: index per SHAPES id) and rebuild.

## Building the pack

`node tools/packs/build-pixellab.mjs` rebuilds `assets/packs/pixellab/` from `test-output/pixellab/sample/` and
the picks, without any API call:
- terrain layers from the transition sets (sea ← deep, shallows, land ← coast, then swamp, scrub, hills, forest,
  mountains, lava clipped to the land), the lower terrain made transparent by `pixellab-mask.mjs`; the shallows
  and lava layers are filled with a picked seamless texture;
- creature sprites from `anim/<name>/` (else the still), `dy` puts their feet 2 px above the cell bottom;
- objects (`OBJECTS`): mirrored E headings, moongate phases 0x40–0x43 (the gate scaled to 2/5…5/5 on its
  ground line, fading in), the bridge stretched to full width and its two ends;
- the `tiles` section (`TILES`, frames and scroll; the secret door is the wall with a crack), `underlay` and
  `groundOnly`;
- a check sheet `test-output/pixellab/sample/missing-sheet.png` (every sprite over its ground, every tile 1×1 and
  3×3, a corner of Britain).

The sample directory has been pruned to what the build and the commands read: the picked candidates, the
transition sets, the characters and their frames, `headless-base.png`, the generation metadata (`*.json`: prompts,
seeds, character ids). It is local (`test-output/`): if it is lost, the pack itself is versioned, and new art in
the same style comes from the commands above (new seeds give different candidates).

Signs (letters 0x60–0x7E and the frames 0x7C/0x7D) are not in the pack: they keep the classic tiles.
