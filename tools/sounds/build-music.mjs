// Assembles the music of the modern sound pack, assets/music/modern/ (versioned, generated tracks only), from
// the tracks of test-output/music/ chosen in tools/sounds/music-picks.json. Each track is loudness-normalised
// with ffmpeg (quieter than the effects: the music stays in the background).
//   node tools/sounds/build-music.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "./ffmpeg.mjs";

const SRC = path.resolve("test-output/music");
const OUT = path.resolve("assets/music/modern");
const picks = JSON.parse(fs.readFileSync(path.resolve("tools/sounds/music-picks.json"), "utf8")).tracks;

const FF = ffmpeg();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const tracks = {};
for (const [scene, pick] of Object.entries(picks)) {
  if (pick.startsWith("=")) continue;
  const src = path.join(SRC, pick);
  if (!fs.existsSync(src)) { console.log(`missing ${scene}: ${pick}`); continue; }
  execFileSync(FF, ["-v", "error", "-y", "-i", src, "-af", "loudnorm=I=-20:TP=-2:LRA=11", "-ar", "44100", "-b:a", "128k", path.join(OUT, `${scene}.mp3`)]);
  tracks[scene] = { file: `${scene}.mp3` };
}
// stand-ins: another scene's file
for (const [scene, pick] of Object.entries(picks))
  if (pick.startsWith("=")) {
    const of = tracks[pick.slice(1)];
    if (of) tracks[scene] = { file: of.file, stand_in: true }; else console.log(`stand-in of ${scene} missing: ${pick}`);
  }
fs.writeFileSync(path.join(OUT, "music.json"), JSON.stringify({ format: 1, name: "modern", tracks }, null, 1) + "\n");
console.log(`${Object.keys(tracks).length} scenes -> ${path.relative(".", OUT)}`);
