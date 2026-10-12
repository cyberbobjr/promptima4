// Minimal PixelLab API client (https://api.pixellab.ai/v2, see docs/PIXELLAB.md).
// The token is read from PIXELLAB_KEY in the environment or in .env (never printed, never committed).
import fs from "node:fs";
import path from "node:path";

export const API = "https://api.pixellab.ai/v2";

export function token() {
  if (process.env.PIXELLAB_KEY) return process.env.PIXELLAB_KEY.trim();
  const env = path.resolve(".env");
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, "utf8").match(/^\s*PIXELLAB_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1].trim();
  }
  throw new Error("PIXELLAB_KEY not found (environment or .env)");
}

export async function call(method, route, body) {
  let res, text;
  // the free plan allows one job at a time: wait and retry on 429
  for (let tries = 0; ; tries++) {
    res = await fetch(API + route, {
      method,
      headers: { Authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
    // paid plans also run one job at a time: a queued script may wait for another one (~20 min max)
    if (res.status !== 429 || tries >= 240) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

/** PNG file or buffer -> the API's Base64Image object. */
export function b64(png) {
  const buf = Buffer.isBuffer(png) ? png : fs.readFileSync(png);
  return { type: "base64", base64: buf.toString("base64"), format: "png" };
}

/** Writes a Base64Image (or data URL) from a response to a PNG file. */
export function save(img, file) {
  const data = (img.base64 ?? img).replace(/^data:image\/\w+;base64,/, "");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

/** Polls a background job until it is completed or failed. */
export async function waitJob(id, { every = 3000, max = 600000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const j = await call("GET", `/background-jobs/${id}`);
    if (j.status === "completed") return j;
    if (j.status === "failed") throw new Error(`job ${id} failed: ${JSON.stringify(j).slice(0, 400)}`);
    if (Date.now() - t0 > max) throw new Error(`job ${id}: timeout`);
    await new Promise((r) => setTimeout(r, every));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  // node tools/packs/pixellab.mjs balance
  if (process.argv[2] === "balance") console.log(JSON.stringify(await call("GET", "/balance")));
}
