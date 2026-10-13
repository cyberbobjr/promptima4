// Sound effects generated with ElevenLabs (text to sound), for a modern sound pack that replaces the
// PC-speaker effects. Prompts and settings are the style: keep them to regenerate in the same spirit.
//
//   node tools/sounds/sfx.mjs [name ...]   generate the variants not on disk yet (all sounds without names)
//   node tools/sounds/sfx.mjs page          listening page test-output/sounds/index.html
//
// Output: test-output/sounds/sfx/<name>/<n>.mp3 (local); picks and the pack assembly come later.
import fs from "node:fs";
import path from "node:path";
import { call } from "./elevenlabs.mjs";

const OUT = path.resolve("test-output/sounds/sfx");
/** Shared style, appended to every prompt. */
const STYLE = "high quality fantasy RPG video game sound effect, clean recording, no music, no voice";

/**
 * name -> [prompt, duration in seconds (0.5-30), variants]. The first ones replace the original effects
 * (src/audio/speaker.ts SFX); the others are new events of the modern pack.
 */
export const SOUNDS = {
  // SFX.STEP, split by ground
  "step-grass": ["one single soft footstep on grass", 0.5, 3],
  "step-stone": ["one single footstep of a leather boot on stone paving", 0.5, 3],
  // SFX.ERROR / SFX.BAD_COMMAND
  blocked: ["dull soft thud of bumping into a wall", 0.5, 2],
  "bad-command": ["short soft wooden UI error click, gentle denial", 0.5, 2],
  // SFX.ATTACK, SFX.HIT, a miss
  "sword-swing": ["quick sword swing whoosh through the air", 0.6, 3],
  "sword-hit": ["sword striking a monster, meaty impact with a metallic clang", 0.7, 3],
  miss: ["blade whooshing past and missing, light air swish", 0.5, 2],
  // SFX.MONSTER_ATTACK, SFX.HURT
  "monster-attack": ["monster claw swipe with a short growl", 0.8, 2],
  hurt: ["heavy blunt hit on a leather armoured adventurer", 0.6, 2],
  // SFX.MAGIC, SFX.CAST
  "spell-cast": ["magic spell cast, sparkling shimmering energy rising", 1.5, 2],
  moongate: ["magical blue portal opening, deep ethereal hum and a whoosh of light", 2.5, 2],
  // SFX.CANNON
  cannon: ["old ship cannon firing, deep boom with a wooden creak", 1.5, 2],
  // new events
  // the first prompt ("heavy wooden door creaking open") was a loud harsh creak
  door: ["gentle quiet wooden door opening softly, light latch click, smooth hinge", 1, 3],
  chest: ["wooden treasure chest opening followed by a jingle of gold coins", 1.5, 2],
  "level-up": ["short triumphant magical chime, bright and uplifting", 2, 2],
  // second batch: the remaining original effects and the steps of the other grounds and mounts
  "step-wood": ["one single footstep on a wooden plank floor", 0.5, 2],
  "step-horse": ["one single horse hoof step on grass", 0.5, 2],
  sail: ["wooden sailing ship creaking with a soft splash of waves", 1, 2],
  flee: ["quick light running footsteps hurrying away", 0.8, 2],
  whirlpool: ["swirling whirlpool of churning sea water, deep rushing vortex", 2.5, 2],
  twister: ["howling tornado wind gust rushing past", 2.5, 2],
};

async function generate(name) {
  const [prompt, duration, variants] = SOUNDS[name];
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= variants; i++) {
    const file = path.join(dir, `${i}.mp3`);
    if (fs.existsSync(file)) continue;
    const buf = await call("POST", "/v1/sound-generation?output_format=mp3_44100_128", {
      text: `${prompt}, ${STYLE}`, duration_seconds: duration, prompt_influence: 0.6, model_id: "eleven_text_to_sound_v2",
    }, true);
    fs.writeFileSync(file, buf);
    console.log(`${name} ${i}: ${buf.length} bytes`);
  }
}

/** One page with every variant, to listen and pick (served by the dev server under /test-output/). */
function page() {
  const rows = Object.entries(SOUNDS).map(([name, [prompt]]) => {
    const dir = path.join(OUT, name);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mp3")).sort() : [];
    const players = files.map((f) => `<figure><figcaption>${f.replace(".mp3", "")}</figcaption><audio controls preload="none" src="sfx/${name}/${f}"></audio></figure>`).join("");
    return `<section><h2>${name}</h2><p>${prompt}</p><div>${players}</div></section>`;
  }).join("\n");
  fs.writeFileSync(path.join(OUT, "..", "index.html"), `<!doctype html><meta charset="utf-8"><title>Sound effects</title>
<style>body{font:14px system-ui;background:#111;color:#ddd;margin:20px}section{border-bottom:1px solid #333;padding:8px 0}
h2{margin:0;font-size:16px;color:#9cf}p{margin:2px 0 6px;color:#888}div{display:flex;flex-wrap:wrap;gap:12px}
figure{margin:0}figcaption{font-size:12px;color:#aaa}</style><h1>Sound effects</h1>${rows}`);
  console.log("test-output/sounds/index.html");
}

const args = process.argv.slice(2);
if (args[0] === "page") page();
else {
  for (const name of args.length ? args : Object.keys(SOUNDS)) await generate(name);
  page();
}
