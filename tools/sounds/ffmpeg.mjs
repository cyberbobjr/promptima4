// ffmpeg for the sound tools: on PATH, else the winget install (Gyan.FFmpeg).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function ffmpeg() {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return "ffmpeg"; } catch { /* not on PATH */ }
  const root = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/WinGet/Packages");
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : [])
    if (d.startsWith("Gyan.FFmpeg")) for (const v of fs.readdirSync(path.join(root, d))) {
      const exe = path.join(root, d, v, "bin", "ffmpeg.exe");
      if (fs.existsSync(exe)) return exe;
    }
  throw new Error("ffmpeg not found");
}
