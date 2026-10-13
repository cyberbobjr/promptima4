// The palette PNG decoder (src/assets/png.ts) against pngjs on every extracted picture and tile sheet
// (skipped when assets/original has not been extracted).
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { decodeIndexedPng } from "../src/assets/png";
import { EGA_PALETTE } from "../src/formats/ega";

const ROOT = path.resolve("assets/original");
const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".png") && files.push(path.join(d, e.name)); };
if (fs.existsSync(ROOT)) walk(ROOT);

describe.skipIf(files.length === 0)("decodeIndexedPng", () => {
  it("matches pngjs on the extracted PNGs", async () => {
    const index = new Map(EGA_PALETTE.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]));
    for (const f of files) {
      const buf = fs.readFileSync(f);
      const ref = PNG.sync.read(buf);
      const got = await decodeIndexedPng(new Blob([buf]));
      expect([got.width, got.height], f).toEqual([ref.width, ref.height]);
      const want = new Uint8Array(ref.width * ref.height);
      for (let i = 0; i < want.length; i++) want[i] = index.get((ref.data[i * 4] << 16) | (ref.data[i * 4 + 1] << 8) | ref.data[i * 4 + 2])!;
      expect(Buffer.from(got.pixels).equals(Buffer.from(want)), f).toBe(true);
    }
  });
});
