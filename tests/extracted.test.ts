// Checks the extracted assets against the engine: every declared text exists in the committed catalog,
// and after a local extraction (manifest.json, git-ignored) every file it lists is there.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { setGameText, textSpecs } from "../src/data/text";
import "../src/data/all-texts";
import { unpackExepack } from "../tools/exe/exepack";
import { hasGame, readGame } from "./gamedir";

const ASSETS = path.resolve("assets/original");
const hasAssets = fs.existsSync(path.join(ASSETS, "i18n/en/game.json"));
const hasManifest = fs.existsSync(path.join(ASSETS, "manifest.json"));
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ASSETS, rel), "utf8"));

describe.skipIf(!hasGame)("EXEPACK", () => {
  it("unpacks AVATAR.EXE to the documented image", () => {
    const u = unpackExepack(readGame("AVATAR.EXE"));
    expect(u.image.length).toBe(0x1821 * 16);
    expect([u.cs, u.ip, u.ss, u.sp]).toEqual([0, 0xe94a, 0x1885, 0x800]);
  });
});

describe.skipIf(!hasAssets)("extracted assets", () => {
  beforeAll(() => setGameText(readJson("i18n/en/game.json")));

  it("has a text for every declared key", () => {
    const cat = readJson("i18n/en/game.json");
    const missing = [...textSpecs()].filter(([k, s]) => s.kind !== "port" && cat[k] === undefined).map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it.skipIf(!hasManifest)("lists every written file in the manifest", () => {
    const m = readJson("manifest.json");
    for (const f of m.files) expect(fs.existsSync(path.join(ASSETS, f)), f).toBe(true);
  });
});
