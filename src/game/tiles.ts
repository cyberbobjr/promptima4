// Tile indices of SHAPES.EGA (identified from the tile sheet and the map files).
import { SLOW_TERRAIN, WALKABLE_TILES } from "../data/tables";
export const T = {
  DEEP_WATER: 0x00, WATER: 0x01, SHALLOWS: 0x02, SWAMP: 0x03, GRASS: 0x04, SCRUB: 0x05, FOREST: 0x06,
  HILLS: 0x07, MOUNTAINS: 0x08, DUNGEON: 0x09, TOWN: 0x0a, CASTLE: 0x0b, VILLAGE: 0x0c,
  LCB_WEST: 0x0d, LCB_ENTRANCE: 0x0e, LCB_EAST: 0x0f,
  SHIP_W: 0x10, SHIP_N: 0x11, SHIP_E: 0x12, SHIP_S: 0x13, HORSE_W: 0x14, HORSE_E: 0x15,
  DUNGEON_FLOOR: 0x16, BRIDGE: 0x17, BALLOON: 0x18, BRIDGE_N: 0x19, BRIDGE_S: 0x1a,
  LADDER_UP: 0x1b, LADDER_DOWN: 0x1c, RUINS: 0x1d, SHRINE: 0x1e, AVATAR: 0x1f,
  COLUMN: 0x30, SHORE_SW: 0x31, SHORE_SE: 0x32, SHORE_NW: 0x33, SHORE_NE: 0x34,
  SHIP_MAST: 0x35, SHIP_WHEEL: 0x36, ROCKS: 0x37, CORPSE: 0x38, RUBBLE: 0x39,
  DOOR: 0x3a, LOCKED_DOOR: 0x3b, CHEST: 0x3c, ANKH: 0x3d, BRICK_FLOOR: 0x3e, WOOD_FLOOR: 0x3f,
  MOONGATE0: 0x40, MOONGATE3: 0x43,
  POISON_FIELD: 0x44, ENERGY_FIELD: 0x45, FIRE_FIELD: 0x46, SLEEP_FIELD: 0x47,
  SOLID: 0x48, SECRET_DOOR: 0x49, ALTAR: 0x4a, CAMPFIRE: 0x4b, LAVA: 0x4c,
  MISSILE: 0x4d, MAGIC_FLASH: 0x4e, HIT_FLASH: 0x4f,
  GUARD: 0x50, CITIZEN: 0x52, SINGING_BARD: 0x54, JESTER: 0x56, BEGGAR: 0x58, CHILD: 0x5a, BULL: 0x5c, LORD_BRITISH: 0x5e,
  LETTER_A: 0x60, LETTER_SPACE: 0x7a, WALL: 0x7f,
  PIRATE_SHIP: 0x80,
} as const;

/** First tile of each class's two-frame figure: mage, bard, fighter, druid, tinker, paladin, ranger, shepherd. */
export const CLASS_TILES = [0x20, 0x22, 0x24, 0x26, 0x28, 0x2a, 0x2c, 0x2e];

export const enum Walk { Foot = 1, Horse = 2, Ship = 4, Balloon = 8 }

/** How each tile can be traversed. Foot/horse list from DS:0x0904 (tested by 1000:2999). */
const WALKABLE = new Set(WALKABLE_TILES);
export function tileFlags(t: number): number {
  if (t === T.DEEP_WATER || t === T.WATER) return Walk.Ship | Walk.Balloon;
  if (t === T.SHALLOWS || (t >= T.SHORE_SW && t <= T.SHORE_NE)) return Walk.Balloon;
  if (WALKABLE.has(t)) return Walk.Foot | Walk.Horse | Walk.Balloon;
  return t === T.MOUNTAINS ? 0 : Walk.Balloon;
}

/** Chance that a move onto this tile is refused ("Slow progress!"), 1000:29EF. */
export function slowChance(t: number): number {
  return SLOW_TERRAIN[t] ?? 0;
}

/** Shop counters and signs: one can talk across them. */
export function isTalkOver(t: number): boolean {
  return t >= T.LETTER_A && t <= 0x7e;
}

/** Tiles that block line of sight. */
export function isOpaque(t: number): boolean {
  return t === T.FOREST || t === T.MOUNTAINS || t === T.WALL || t === T.SECRET_DOOR || t === T.SOLID ||
    t === T.DOOR || t === T.LOCKED_DOOR;
}

/** Tiles animated by row rotation (water) */
export const SCROLL_TILES = [T.DEEP_WATER, T.WATER, T.SHALLOWS, T.POISON_FIELD, T.ENERGY_FIELD, T.FIRE_FIELD, T.SLEEP_FIELD, T.LAVA];

/** Two-frame figures: tile pairs that alternate frames. Monsters from 0x90 have four frames. */
export function animFrame(t: number, frame: number): number {
  if (t >= 0x80 && t <= 0x83) return t; // pirate ships keep their heading (1000:3605 does not animate 0x80)
  if ((t >= 0x20 && t <= 0x2f) || (t >= 0x50 && t <= 0x5f) || (t >= 0x80 && t < 0x90)) return (t & ~1) | (frame & 1);
  if (t >= 0x90) return (t & ~3) | (frame & 3);
  return t;
}
