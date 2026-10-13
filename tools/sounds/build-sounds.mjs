// Assembles the modern sound pack assets/sounds/modern/ (versioned, generated sounds only) from the
// variants picked in tools/sounds/picks.json among test-output/sounds/sfx/ (tools/sounds/sfx.mjs). Each sound
// is loudness-normalised with ffmpeg so that the pack plays at one level; no API call.
//   node tools/sounds/build-sounds.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "./ffmpeg.mjs";

const SRC = path.resolve("test-output/sounds/sfx");
const OUT = path.resolve("assets/sounds/modern");
const picks = JSON.parse(fs.readFileSync(path.resolve("tools/sounds/picks.json"), "utf8")).sounds;

const FF = ffmpeg();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const events = {};
for (const [name, pick] of Object.entries(picks)) {
  // a name: this sound is not generated yet, the event plays that other one
  if (typeof pick === "string") { events[name] = { file: `${pick}.mp3`, stand_in: true }; continue; }
  const src = path.join(SRC, name, `${pick}.mp3`);
  if (!fs.existsSync(src)) { console.log(`missing ${name} ${pick}`); continue; }
  // EBU R128 loudness (short sounds: integrated loudness over the whole clip), true peak -1.5 dB
  execFileSync(FF, ["-v", "error", "-y", "-i", src, "-af", "loudnorm=I=-18:TP=-1.5:LRA=11", "-ar", "44100", "-b:a", "128k", path.join(OUT, `${name}.mp3`)]);
  events[name] = { file: `${name}.mp3` };
}
for (const [name, e] of Object.entries(events)) if (e.stand_in && !fs.existsSync(path.join(OUT, e.file))) console.log(`stand-in of ${name} missing: ${e.file}`);
fs.writeFileSync(path.join(OUT, "sounds.json"), JSON.stringify({ format: 1, name: "modern", events }, null, 1) + "\n");
console.log(`${Object.keys(events).length} events -> ${path.relative(".", OUT)}`);
