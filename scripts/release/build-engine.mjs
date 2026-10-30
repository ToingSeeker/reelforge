// Builds the engine the desktop app ships with, into apps/desktop/src-tauri/engine/:
//   reelforge.mjs  one-file bundle of the CLI (serve, mcp, …)
//   node           the official Node.js runtime (nodejs.org, SHA-256 verified), not Homebrew's,
//                  which links against Homebrew libraries the user may not have
//   fonts/         the OFL caption fonts
// Usage: node scripts/release/build-engine.mjs
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { thirdPartyNotices } from "./third-party-notices.mjs";

const NODE_VERSION = "24.22.2";
// From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
const NODE_SHA256 = {
  arm64: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "apps/desktop/src-tauri/engine");
const cache = join(root, ".reelforge/release-cache");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

// 1. Bundle. node:* builtins stay external; everything else (zod, SDKs, opentype.js) is inlined.
await build({
  entryPoints: [join(root, "packages/cli/bin/reelforge.js")],
  outfile: join(out, "reelforge.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Some CommonJS dependencies call require(); give ESM a real one. Named so it can't collide with a
  // dependency that imports createRequire itself.
  banner: { js: 'import { createRequire as __rfCreateRequire } from "node:module"; const require = __rfCreateRequire(import.meta.url);' },
  legalComments: "external",
  logLevel: "warning",
});

// 2. Node runtime.
const a = arch();
if (!NODE_SHA256[a]) throw new Error(`no pinned Node checksum for ${a}`);
const tarName = `node-v${NODE_VERSION}-darwin-${a}.tar.gz`;
const tar = join(cache, tarName);
if (!existsSync(tar)) {
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${tarName}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(tar, Buffer.from(await res.arrayBuffer()));
}
const sha = createHash("sha256").update(readFileSync(tar)).digest("hex");
if (sha !== NODE_SHA256[a]) {
  rmSync(tar);
  throw new Error(`Node tarball checksum mismatch: ${sha}`);
}
const unpack = join(cache, `node-v${NODE_VERSION}-${a}`);
rmSync(unpack, { recursive: true, force: true });
mkdirSync(unpack);
execFileSync("tar", ["-xzf", tar, "-C", unpack, "--strip-components", "1", `node-v${NODE_VERSION}-darwin-${a}/bin/node`, `node-v${NODE_VERSION}-darwin-${a}/LICENSE`]);
cpSync(join(unpack, "bin/node"), join(out, "node"));
chmodSync(join(out, "node"), 0o755);
const nodeLicence = readFileSync(join(unpack, "LICENSE"), "utf8");

// 3. Fonts.
cpSync(join(root, "assets/fonts"), join(out, "fonts"), { recursive: true });

// 4. Licences of everything shipped.
const fontsDir = join(root, "assets/fonts");
const notices = thirdPartyNotices(root, [
  { name: `Node.js ${NODE_VERSION}`, licence: "MIT (and the bundled components listed in its licence)", text: nodeLicence.trim() },
  { name: "Anton (font)", licence: "OFL-1.1", text: readFileSync(join(fontsDir, "OFL-Anton.txt"), "utf8").trim() },
  { name: "Poppins (font)", licence: "OFL-1.1", text: readFileSync(join(fontsDir, "OFL-Poppins.txt"), "utf8").trim() },
]);
writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), notices.text);
console.log(`third-party notices: ${notices.count} components`);

// 5. Smoke test: the bundle parses and runs on the shipped runtime.
execFileSync(join(out, "node"), ["--check", join(out, "reelforge.mjs")]);
const help = execFileSync(join(out, "node"), [join(out, "reelforge.mjs"), "--help"], { encoding: "utf8" });
if (!help.includes("reelforge mcp")) throw new Error("bundled CLI --help looks wrong");
console.log(`engine ready in ${out} (Node ${NODE_VERSION} ${a})`);
