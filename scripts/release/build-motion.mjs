// Packages the motion-graphics renderer (packages/motion, Remotion) into <engine>/motion/:
//   render.mjs     the render process, bundled (core + zod inlined; @remotion/renderer external)
//   bundle/        the compositions, prebuilt by @remotion/bundler, so the app ships no webpack
//   node_modules/  @remotion/renderer and its runtime deps, incl. the native compositor
//   chrome/        Chrome Headless Shell (every file SHA-256 verified), which Remotion drives to draw frames
// Then renders one frame-short graphic with the shipped Node to prove the layout works.
// Usage: node scripts/release/build-motion.mjs <engine dir> [<node binary>]   (build-engine.mjs calls it)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { arch } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Chrome Headless Shell that @remotion/renderer 4.0.539 downloads (157.0.8080.0-remotion-v3).
// Remotion fetches and unzips it with no checksum, so we verify the whole unpacked tree, not just the
// executable: the dylibs, helpers and loader manifests next to it are native code the app ships and loads.
// The digest is chromeTreeDigest() of the folder; recorded 2026-11-21 from two independent downloads that
// matched (4559 files; the executable alone is a6516527d27e69244beafc04f347fc90ef363c23598b951ae05fc96c999b7f54).
const CHROME_TREE_SHA256 = { arm64: "c735c56eda668cf684ff8989a2c1f7a0c2a465bbdaaf63f42089ba54c09b682f" };

/** Finder litter, never part of the download and never shipped. */
const isLitter = (name) => name === ".DS_Store";

/**
 * SHA-256 over every file in the tree: one "path NUL x|- NUL sha256(content)" line per file, sorted. Any
 * added, removed, renamed or changed file, or a changed executable bit, changes it. Symlinks are refused.
 */
export function chromeTreeDigest(root) {
  const lines = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (isLitter(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`unexpected symlink in Chrome Headless Shell: ${relative(root, p)}`);
      if (st.isDirectory()) walk(p);
      else lines.push(`${relative(root, p)}\0${st.mode & 0o111 ? "x" : "-"}\0${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  lines.sort();
  return { files: lines.length, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

export async function buildMotion(root, engineOut, nodeBin = process.execPath) {
  const pkgDir = join(root, "packages/motion");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const version = pkg.dependencies["@remotion/renderer"];
  const out = join(engineOut, "motion");
  const cache = join(root, ".reelforge/release-cache", `remotion-${version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // 1. The render process. Remotion stays external: it resolves its compositor and browser by path.
  await build({
    entryPoints: [join(pkgDir, "src/render.ts")],
    outfile: join(out, "render.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["@remotion/renderer", "@remotion/bundler"],
    banner: { js: 'import { createRequire as __rfCreateRequire } from "node:module"; const require = __rfCreateRequire(import.meta.url);' },
    legalComments: "external",
    logLevel: "warning",
  });

  // 2. The compositions, bundled once here with the dev-only bundler.
  const req = createRequire(join(pkgDir, "package.json"));
  const { bundle } = await import(pathToFileURL(req.resolve("@remotion/bundler")).href);
  await bundle({ entryPoint: join(pkgDir, "src/entry.ts"), outDir: join(out, "bundle"), enableCaching: false });
  // Keep the source maps: the renderer opens bundle.js.map at startup (stripping them fails every render).

  // 3. Renderer runtime: exact versions (Remotion pins its own dependencies exactly); no install scripts.
  writeFileSync(join(out, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@remotion/renderer": version } }, null, 2));
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"], { cwd: out, stdio: "inherit" });
  const a = arch();
  if (!existsSync(join(out, `node_modules/@remotion/compositor-darwin-${a}`))) throw new Error(`Remotion compositor for darwin-${a} missing`);
  // Executable shims are symlinks (trip up the app bundle's resource copy and signing); nothing runs them.
  rmSync(join(out, "node_modules/.bin"), { recursive: true, force: true });

  // 4. Chrome Headless Shell, downloaded once per Remotion version into the release cache.
  if (!CHROME_TREE_SHA256[a]) throw new Error(`no pinned Chrome checksum for ${a}`);
  const chromeCache = join(cache, "chrome");
  if (!existsSync(join(chromeCache, "chrome-headless-shell"))) {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    execFileSync(nodeBin, ["--input-type=module", "-e", "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser({ logLevel: 'error' });"], { cwd: out, stdio: "inherit" });
    cpSync(join(out, `node_modules/.remotion/chrome-headless-shell/mac-${a}/chrome-headless-shell-mac-${a}`), chromeCache, { recursive: true });
    rmSync(join(out, "node_modules/.remotion"), { recursive: true, force: true });
  }
  const tree = chromeTreeDigest(chromeCache);
  if (tree.sha256 !== CHROME_TREE_SHA256[a]) {
    rmSync(cache, { recursive: true, force: true });
    throw new Error(`Chrome Headless Shell checksum mismatch (${tree.files} files): ${tree.sha256}`);
  }
  cpSync(chromeCache, join(out, "chrome"), { recursive: true, filter: (src) => !isLitter(basename(src)) });
  // Vulkan's debug validation layer (23 MB) is for GPU driver development; rendering never loads it.
  rmSync(join(out, "chrome/libVkLayer_khronos_validation.dylib"), { force: true });
  chmodSync(join(out, "chrome/chrome-headless-shell"), 0o755);

  // 5. Smoke test with the shipped Node, the packaged layout, and nothing from the monorepo.
  const tmp = join(cache, "smoke");
  rmSync(tmp, { recursive: true, force: true });
  const spec = { key: "0000000000000000", template: "badge", props: { text: "OK", accent: "#ff5a36", color: "#ffffff", corner: "top-right" }, width: 320, height: 180, fps: { num: 30, den: 1 }, frames: 4 };
  const request = { spec, output: join(tmp, "smoke.mov"), cacheDir: tmp, bundleDir: join(out, "bundle"), browserExecutable: join(out, "chrome/chrome-headless-shell") };
  const res = execFileSync(nodeBin, [join(out, "render.mjs")], { input: `${JSON.stringify(request)}\n`, encoding: "utf8", cwd: cache, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  if (!res.includes('"done":true') || !existsSync(request.output)) throw new Error(`motion smoke render failed: ${res}`);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`motion renderer ready in ${out} (Remotion ${version})`);
  return { version, licence: readFileSync(join(out, "node_modules/remotion/LICENSE.md"), "utf8").trim(), chromeLicence: readFileSync(join(out, "chrome/LICENSE.headless_shell"), "utf8").trim() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  await buildMotion(root, resolve(process.argv[2] ?? join(root, "apps/desktop/src-tauri/engine")), process.argv[3]);
}
