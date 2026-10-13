// Minimal ElevenLabs API client (https://api.elevenlabs.io, sound effects and music).
// The key is read from ELEVEN_LABS_KEY in the environment or in .env (never printed, never committed).
//   node tools/sounds/elevenlabs.mjs balance     characters / credits left on the subscription
import fs from "node:fs";
import path from "node:path";

export const API = "https://api.elevenlabs.io";

export function key() {
  if (process.env.ELEVEN_LABS_KEY) return process.env.ELEVEN_LABS_KEY.trim();
  const env = path.resolve(".env");
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, "utf8").match(/^\s*ELEVEN_LABS_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1].trim();
  }
  throw new Error("ELEVEN_LABS_KEY not found (environment or .env)");
}

/** JSON call; `raw` returns the response body as a Buffer (audio endpoints). */
export async function call(method, route, body, raw = false) {
  let res;
  for (let tries = 0; ; tries++) {
    res = await fetch(API + route, {
      method,
      headers: { "xi-api-key": key(), "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    // concurrency limit of the plan: wait and retry
    if (res.status !== 429 || tries >= 60) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  if (process.argv[2] === "balance") {
    const s = await call("GET", "/v1/user/subscription");
    console.log(JSON.stringify({ tier: s.tier, used: s.character_count, limit: s.character_limit, reset: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null }));
  }
}
