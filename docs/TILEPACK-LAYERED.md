# Layered tile packs (format 2)

Classic packs (format 1, `src/assets/store.ts` `TilePack`) are one opaque atlas indexed like SHAPES.EGA: every
map square is one tile. A **layered pack** draws the map views as a modern 2D game does:

1. a scrolling **base** water texture under everything;
2. **terrain layers**, bottom to top, each drawn on a *dual grid*: one transition tile centred on every corner
   shared by 4 map cells, chosen by which of those 4 cells belong to the layer (Wang corner tiles). The part of a
   tile that is not the layer's terrain is transparent, so layers stack (water, then land, then forest...);
3. black squares for the cells hidden by line of sight;
4. **sprites** (places, creatures, objects) with transparency and animation frames, drawn over the terrain;
   a creature frame may be larger than a cell and overflow into its neighbours (clipped to the viewport).

Any tile id the pack does not cover (town floors, walls, letters, fields, dungeon tiles...) is drawn opaque from
the pack's **fallback** classic pack, exactly as today.

The first layered pack is `assets/packs/pixellab/` (art generated with PixelLab, not derived from the original
game: it is versioned in git). It is built by `tools/packs/build-pixellab.mjs`.

## pack.json

```jsonc
{
  "name": "PixelLab",
  "format": 2,
  "tileSize": 32,                      // pixels of one map cell in this pack's images
  "fallback": "scale4x-derived",       // classic pack for uncovered tiles; "original" if that one is missing
  "fps": 6,                            // sprite animation and water scroll rate (independent of the game tick)
  "base": { "image": "terrain/base.png", "scroll": [1, 0] },   // tileSize x tileSize, tileable; pixels per frame
  "terrainIds": [0, 1, 2, 3, 4, 5, 6, 7, 8],                   // SHAPES ids that are ground (drawn by the layers)
  "layers": [
    // image: 16 tiles of tileSize in one row; tile index = NW*8 + NE*4 + SW*2 + SE (1 = corner cell is a member)
    // members: SHAPES ids of the cells that belong to the layer
    // fill (optional): the tile alpha is only a mask, the colour comes from this tileable texture, scrolled
    //                  like the base (animated water under the coasts)
    // clip (optional): "land" = only drawn where the layer named "land" is opaque (land terrains never cover water)
    { "name": "sea", "members": [1, 2, 3, 4, 5, 6, 7, 8], "image": "terrain/sea.png", "fill": "terrain/sea-fill.png", "scroll": [1, 0] },
    { "name": "shallows", "members": [2], "image": "terrain/shallows.png", "fill": "terrain/shallows-fill.png", "scroll": [1, 0] },
    { "name": "land", "members": [3, 4, 5, 6, 7, 8], "image": "terrain/land.png" },
    { "name": "swamp", "members": [3], "image": "terrain/swamp.png", "clip": "land" },
    { "name": "scrub", "members": [5], "image": "terrain/scrub.png", "clip": "land" },
    { "name": "hills", "members": [7], "image": "terrain/hills.png", "clip": "land" },
    { "name": "forest", "members": [6], "image": "terrain/forest.png", "clip": "land" },
    { "name": "mountains", "members": [8], "image": "terrain/mountains.png", "clip": "land" }
  ],
  // ground under a sprite tile when the caller gives no ground (see setView): SHAPES id -> terrain id
  "underlay": { "9": 8, "10": 4, "11": 4, "14": 4, "30": 4 },
  // ids drawn as plain ground (no sprite, no fallback): e.g. the two side tiles of Lord British's castle
  "groundOnly": { "13": 4, "15": 4 },
  "sprites": [
    // ids: every SHAPES id shown with this sprite (all animation-frame variants of a creature)
    // image: frames in one row, each w x h pixels; drawn centred horizontally on the cell, bottom edge at the
    //        cell bottom + dy pixels (pack scale). One frame = static.
    { "name": "town", "ids": [10], "image": "sprites/town.png", "w": 32, "h": 32, "frames": 1, "dy": 0 },
    { "name": "orc", "ids": [192, 193, 194, 195], "image": "sprites/orc.png", "w": 44, "h": 44, "frames": 8, "dy": 4 }
  ]
}
```

## Renderer contract

`Renderer.setView(tiles: number[] | null, ground?: number[])`

- `tiles`: unchanged — 121 SHAPES ids of the 11x11 viewport, -1 = black (line of sight), as returned by
  `viewTiles()` or a layer's `view()`.
- `ground` (optional, layered packs only): **13x13** SHAPES ids of the map cells under the viewport *plus a ring
  of one cell* (row-major, index `(vy + 1) * 13 + (vx + 1)` for viewport cell vx, vy in -1..11), **without**
  creatures, objects or line of sight — the plain map tiles. Needed by the dual grid (tiles on the outer corners
  read the ring). When absent, the renderer derives it from `tiles`: terrain ids as they are, sprite ids through
  `underlay`, everything else as grass (4); the ring repeats the edge cells.
- Per cell, with a layered pack: if the ground id is not in `terrainIds` (a town floor, a wall...), the layers
  treat it as grass (4) for the corner tests and the fallback tile is drawn opaque over the cell. If `tiles[i]`
  is a sprite id, the sprite is drawn over the ground; if it is any other non-terrain id, the fallback tile is
  drawn opaque; -1 draws black.
- Animation: frame = floor(time * fps) + a per-cell phase (e.g. the cell's map x) so creatures are not in step;
  the base and `fill` textures shift by `scroll` pixels per frame (wrapping).
- Everything else that uses the classic atlas (`drawViewTile`, missiles, the intro, the dungeon view, inverts)
  keeps using the fallback pack's atlas.

## Tile ids used by the PixelLab pack

| ids | sprite name |
|---|---|
| 9 dungeon, 10 town, 11 castle, 14 Lord British's castle entrance (castle sprite), 30 shrine | dungeon, town, castle, castle, shrine |
| 0x1F | avatar |
| 0x20/21 mage, 22/23 bard, 24/25 fighter, 26/27 druid, 28/29 tinker, 2A/2B paladin, 2C/2D ranger, 2E/2F shepherd | class names |
| 0x50/51 guard, 52/53 merchant, 54/55 minstrel, 56/57 jester, 58/59 beggar, 5A/5B child, 5C/5D bull, 5E/5F king | townsfolk |
| 0x84/85 nixie, 86/87 squid, 88/89 seaserpent, 8A/8B seahorse, 8C/8D whirlpool, 8E/8F twister | sea creatures |
| 0x90 rat, 94 bat, 98 spider, 9C ghost, A0 slime, A4 troll, A8 gremlin, AC mimic, B0 reaper, B4 insects, B8 gazer, BC phantom, C0 orc, C4 skeleton, C8 rogue, CC python, D0 ettin, D4 headless, D8 cyclops, DC wisp, E0 evilmage, E4 liche, E8 lavalizard, EC zorn, F0 daemon, F4 hydra, F8 dragon, FC balron (each id .. id+3) | land monsters |
