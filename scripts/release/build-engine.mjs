// Builds the engine the desktop app ships with, into apps/desktop/src-tauri/engine/:
//   reelforge.mjs  one-file bundle of the CLI (serve, mcp, …)
//   node           the official Node.js runtime (nodejs.org, SHA-256 verified), not Homebrew's,
//                  which links against Homebrew libraries the user may not have
//   fonts/         the OFL caption fonts
//   fx/            the AI effects engine (packages/fx-engine) with its own Python: a standalone
//                  CPython build (SHA-256 verified) and the pinned wheels (pip --require-hashes)
//   motion/        the motion-graphics renderer: Remotion, a prebuilt bundle, Chrome Headless Shell
//                  (build-motion.mjs)
// Usage: node scripts/release/build-engine.mjs
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { thirdPartyNotices } from "./third-party-notices.mjs";
import { buildMotion } from "./build-motion.mjs";

const NODE_VERSION = "24.22.2";
// From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
const NODE_SHA256 = {
  arm64: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
};

// python-build-standalone (astral-sh), install_only build. From the release's published digest.
const PYTHON_BUILD = "cpython-3.12.15+20261013";
const PYTHON_SHA256 = {
  arm64: "ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440",
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

// 4. AI effects engine: its scripts, models and fonts, plus a private Python with the pinned wheels.
const fxOut = join(out, "fx");
const fxSrc = join(root, "packages/fx-engine");
for (const part of ["scripts/fx.py", "models", "fonts", "LICENSE", "README.md"]) cpSync(join(fxSrc, part), join(fxOut, part), { recursive: true });
const pyTarName = `${PYTHON_BUILD}-aarch64-apple-darwin-install_only.tar.gz`;
const pyTar = join(cache, pyTarName);
if (a !== "arm64") throw new Error(`no pinned Python build for ${a}`);
if (!existsSync(pyTar)) {
  const res = await fetch(`https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD.split("+")[1]}/${encodeURIComponent(pyTarName)}`);
  if (!res.ok) throw new Error(`Python download failed: ${res.status}`);
  writeFileSync(pyTar, Buffer.from(await res.arrayBuffer()));
}
const pySha = createHash("sha256").update(readFileSync(pyTar)).digest("hex");
if (pySha !== PYTHON_SHA256[a]) {
  rmSync(pyTar);
  throw new Error(`Python tarball checksum mismatch: ${pySha}`);
}
execFileSync("tar", ["-xzf", pyTar, "-C", fxOut]); // → fx/python/
const py = join(fxOut, "python/bin/python3");
const wheels = join(cache, "fx-wheels");
mkdirSync(wheels, { recursive: true });
const lock = join(fxSrc, "requirements-macos-arm64.lock");
// Every wheel is checked against the lock's SHA-256; no source builds, no dependency resolution.
const pip = ["-I", "-m", "pip", "--disable-pip-version-check", "--no-input"];
execFileSync(py, [...pip, "download", "--quiet", "--no-deps", "--only-binary=:all:", "--require-hashes", "-r", lock, "-d", wheels], { stdio: "inherit" });
execFileSync(py, [...pip, "install", "--quiet", "--no-deps", "--no-index", "--find-links", wheels, "--only-binary=:all:", "--require-hashes", "--no-compile", "-r", lock], { stdio: "inherit" });
// Trim what a headless engine never uses, then precompile (hash-checked, so copying the app's files doesn't
// invalidate them; the bundle is read-only once signed).
const lib = join(fxOut, "python/lib/python3.12");
for (const dir of ["test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "site-packages/pip", "site-packages/numpy/_core/tests", "site-packages/matplotlib/tests"]) {
  rmSync(join(lib, dir), { recursive: true, force: true });
}
for (const f of readdirSync(join(lib, "site-packages"))) if (/^pip-.*\.dist-info$/.test(f)) rmSync(join(lib, "site-packages", f), { recursive: true, force: true });
// Packages' own test suites (MediaPipe's don't even compile on 3.12), Tcl/Tk and C headers.
for (const d of readdirSync(join(lib, "site-packages"), { recursive: true, withFileTypes: true })) {
  if (d.isDirectory() && (d.name === "tests" || d.name === "test")) rmSync(join(d.parentPath, d.name), { recursive: true, force: true });
}
for (const f of readdirSync(join(fxOut, "python/lib"))) if (/^(libtcl|libtk|tcl|tk)/.test(f)) rmSync(join(fxOut, "python/lib", f), { recursive: true, force: true });
rmSync(join(fxOut, "python/include"), { recursive: true, force: true });
execFileSync(py, ["-I", "-m", "compileall", "-q", "-j", "0", "--invalidation-mode", "unchecked-hash", lib], { stdio: "inherit" });
execFileSync(py, ["-I", "-c", "import mediapipe, cv2, numpy, PIL; from mediapipe.tasks.python import vision"], { stdio: "inherit" });
const pyLicence = readFileSync(join(fxOut, "python/lib/python3.12/LICENSE.txt"), "utf8");

// 4b. Motion graphics renderer (Remotion), smoke-tested with the shipped Node.
const motion = await buildMotion(root, out, join(out, "node"));

// 5. Licences of everything shipped.
const fontsDir = join(root, "assets/fonts");
const notices = thirdPartyNotices(root, [
  { name: `Node.js ${NODE_VERSION}`, licence: "MIT (and the bundled components listed in its licence)", text: nodeLicence.trim() },
  { name: "Anton (font)", licence: "OFL-1.1", text: readFileSync(join(fontsDir, "OFL-Anton.txt"), "utf8").trim() },
  { name: "Poppins (font)", licence: "OFL-1.1", text: readFileSync(join(fontsDir, "OFL-Poppins.txt"), "utf8").trim() },
  { name: "claude-video-effects (AI effects engine, by Vibha Ramprakash)", licence: "MIT", text: readFileSync(join(fxSrc, "LICENSE"), "utf8").trim() },
  { name: "AI effects models (YuNet: MIT; MediaPipe Selfie Segmenter: Apache-2.0)", licence: "MIT / Apache-2.0", text: readFileSync(join(fxSrc, "models/NOTICE.md"), "utf8").trim() },
  ...readdirSync(join(fxSrc, "fonts"))
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ name: `AI effects font (${f.replace(/^(OFL|LICENSE)-|\.txt$/g, "")})`, licence: f.startsWith("OFL") ? "OFL-1.1" : "Apache-2.0", text: readFileSync(join(fxSrc, "fonts", f), "utf8").trim() })),
  { name: "Chrome Headless Shell (Remotion's build, motion graphics)", licence: "BSD-3-Clause (Chromium) and the components listed in its licence", text: motion.chromeLicence },
  { name: `CPython ${PYTHON_BUILD} (python-build-standalone)`, licence: "PSF-2.0 (and the bundled components listed in its licence)", text: pyLicence.trim() },
  ...readFileSync(lock, "utf8")
    .split("\n")
    .filter((l) => /==/.test(l) && !l.startsWith("#"))
    .map((l) => l.split(" ")[0])
    .map((pkg) => ({ name: `${pkg} (Python package, AI effects)`, licence: "see the package's licence file in fx/python/lib/python3.12/site-packages", text: `${pkg}: licence text ships inside its .dist-info folder in this app.` })),
]);
writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), notices.text);
console.log(`third-party notices: ${notices.count} components`);

// 6. Smoke test: the bundle parses and runs on the shipped runtime.
execFileSync(join(out, "node"), ["--check", join(out, "reelforge.mjs")]);
const help = execFileSync(join(out, "node"), [join(out, "reelforge.mjs"), "--help"], { encoding: "utf8" });
if (!help.includes("reelforge mcp")) throw new Error("bundled CLI --help looks wrong");
console.log(`engine ready in ${out} (Node ${NODE_VERSION} ${a})`);
