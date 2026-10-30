// Writes THIRD_PARTY_NOTICES.txt for what a release ships: production JS packages (engine bundle +
// UI), the Rust crates linked into the desktop shell, Node.js, and the caption fonts. Fails on a
// licence outside the allowlist so a copyleft dependency can't slip into a release unnoticed.
// FFmpeg and whisper.cpp are NOT shipped (users install them), so their licences don't apply here.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ALLOWED = /^(MIT|MIT-0|ISC|0BSD|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|Unlicense|Zlib|CC0-1\.0|Unicode-3\.0|MPL-2\.0|OFL-1\.1)$/;
// MPL-2.0 is file-level copyleft: fine to ship in binaries; the notice below points to the source.

function licenceOk(expr) {
  // "A OR B": one acceptable option is enough; "A AND B": all must be acceptable.
  const norm = expr.replace(/\//g, " OR ").replace(/[()]/g, " ");
  return norm.split(/\s+OR\s+/).some((alt) => alt.split(/\s+AND\s+/).every((id) => ALLOWED.test(id.trim())));
}

function licenceText(dir) {
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
  return files.length ? files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n") : null;
}

export function thirdPartyNotices(root, extra) {
  const entries = [];
  const bad = [];

  const js = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "-r"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }));
  for (const [licence, pkgs] of Object.entries(js)) {
    for (const p of pkgs) {
      if (p.name.startsWith("@reelforge/")) continue;
      if (!licenceOk(licence)) bad.push(`${p.name} (${licence})`);
      entries.push({ name: `${p.name} ${p.versions.join(", ")}`, licence, text: licenceText(p.paths?.[0]) });
    }
  }

  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", "aarch64-apple-darwin"], { cwd: join(root, "apps/desktop/src-tauri"), encoding: "utf8", maxBuffer: 256 << 20 }),
  );
  // Only crates linked into the app: follow normal (not build/dev) dependency edges from the root.
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const linked = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (linked.has(id)) continue;
    linked.add(id);
    for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  for (const p of meta.packages) {
    if (!linked.has(p.id) || p.id === meta.resolve.root) continue;
    const licence = p.license ?? "UNKNOWN";
    if (!licenceOk(licence)) bad.push(`${p.name} (${licence})`);
    const mpl = /MPL-2\.0/.test(licence) && !licenceOk(licence.replace(/MPL-2\.0/g, "X")) ? `\nSource: https://crates.io/crates/${p.name}/${p.version}` : "";
    entries.push({ name: `${p.name} ${p.version} (Rust)`, licence: licence + mpl, text: licenceText(dirname(p.manifest_path)) });
  }

  if (bad.length) throw new Error(`licences outside the allowlist:\n  ${bad.join("\n  ")}`);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const sep = "\n\n" + "-".repeat(78) + "\n\n";
  const head =
    "ReelForge — third-party notices\n\n" +
    "ReelForge is Apache-2.0. This release includes the software listed below under its own licence.\n" +
    "FFmpeg and whisper.cpp are not included; they are installed separately by the user.\n";
  const body = [...extra, ...entries].map((e) => `${e.name}\nLicence: ${e.licence}${e.text ? `\n\n${e.text}` : ""}`).join(sep);
  // Some packages don't ship a licence file; the standard text of the licence they name applies.
  const appendix =
    "Standard licence texts, for components above that name a licence without shipping its text\n\n" +
    `== Apache-2.0 ==\n\n${readFileSync(join(root, "LICENSE"), "utf8").trim()}\n\n` +
    "== MIT ==\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\n" +
    "== Zlib ==\n\nThis software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.\n\nPermission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:\n\n1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.\n2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.\n3. This notice may not be removed or altered from any source distribution.\n";
  return { text: head + sep + body + sep + appendix, count: entries.length + extra.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(new URL(import.meta.url).pathname), "../..");
  const { text, count } = thirdPartyNotices(root, []);
  writeFileSync(process.argv[2] ?? "THIRD_PARTY_NOTICES.txt", text);
  console.log(`${count} components`);
}
