import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, migrateConfig } from "../src/config/config";

describe("config", () => {
  it("merges stored values over the defaults, key by key", () => {
    const c = mergeConfig(structuredClone(DEFAULT_CONFIG), { lang: { ui: "fr" }, debug: { enabled: true } });
    expect(c.lang).toEqual({ game: "en", ui: "fr" });
    expect(c.debug).toEqual({ enabled: true, godMode: false });
    expect(c.tiles.pack).toBe("pixellab");
  });
  it("keeps unknown keys and fills missing sections", () => {
    const c = mergeConfig(structuredClone(DEFAULT_CONFIG), { future: { x: 1 } }) as unknown as Record<string, unknown>;
    expect(c.future).toEqual({ x: 1 });
    expect(mergeConfig(structuredClone(DEFAULT_CONFIG), undefined)).toEqual(DEFAULT_CONFIG);
  });
  it("moves version 1 settings on the former default pack to the PixelLab pack", () => {
    const pack = (raw: unknown) => mergeConfig(structuredClone(DEFAULT_CONFIG), migrateConfig(raw)).tiles.pack;
    expect(pack({ version: 1, tiles: { pack: "original" } })).toBe("pixellab");
    expect(pack({ tiles: { pack: "original" } })).toBe("pixellab");
    expect(pack({ version: 1, tiles: { pack: "scale4x-derived" } })).toBe("scale4x-derived");
    // chosen after the change: kept
    expect(pack({ version: 2, tiles: { pack: "original" } })).toBe("original");
    expect(migrateConfig(undefined)).toBeUndefined();
  });
});
