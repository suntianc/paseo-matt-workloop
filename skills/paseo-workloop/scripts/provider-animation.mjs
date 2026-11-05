import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "provider-icons", "frames");
const providers = new Set(["devin", "codex", "dsh", "pi"]);
const interval = 80;

// Kitty's image payloads are base64 chunks of at most 4096 bytes. Animation
// frames are sent once; Rex drives the animation without a workloop timer.
function transmit(stream, first, continuation, bytes) {
  const data = bytes.toString("base64");
  for (let pos = 0; pos < data.length; pos += 4096) {
    const chunk = data.slice(pos, pos + 4096);
    const control = pos === 0 ? first : continuation;
    stream.write(`\x1b_G${control},m=${pos + 4096 < data.length ? 1 : 0};${chunk}\x1b\\`);
  }
}
const command = (stream, control) => stream.write(`\x1b_G${control};\x1b\\`);

export function createProviderAnimation(provider, { stream = process.stdout, env = process.env, id = randomInt(1, 0x7fffffff) } = {}) {
  let running = false;
  return {
    start() {
      if (!stream.isTTY || env.TERM_PROGRAM !== "rex" || env.TERM === "dumb" || env.WORKLOOP_ANIMATIONS === "0" || !providers.has(provider)) return false;
      let frames;
      try {
        frames = Array.from({ length: 24 }, (_, i) => readFileSync(join(assets, provider, `${String(i).padStart(2, "0")}.png`)));
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      transmit(stream, `a=T,f=100,i=${id},c=4,r=2,C=1,q=2`, "q=2", frames[0]);
      for (const frame of frames.slice(1)) transmit(stream, `a=f,f=100,i=${id},z=${interval},X=1,q=2`, "a=f,q=2", frame);
      command(stream, `a=a,i=${id},r=1,z=${interval},q=2`);
      command(stream, `a=a,i=${id},s=3,v=1,q=2`);
      running = true;
      return true;
    },
    stop() {
      if (!running) return;
      command(stream, `a=a,i=${id},s=1,q=2`);
      running = false;
    },
  };
}
