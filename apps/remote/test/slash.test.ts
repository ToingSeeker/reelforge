// The phone's slash autocomplete (public/slash.js) against core's: given the catalogue the Mac sends, the
// phone must suggest exactly what the desktop suggests and complete the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completeSlash, FX_ALIASES, FX_CATALOG, isSlashCommand, slashCatalog, slashSuggestions } from "../../../packages/core/src/index.ts";

const phone = (await import(new URL("../public/slash.js", import.meta.url).href)) as typeof import("../public/slash.js");

// The catalogue as it reaches the phone: through JSON.
const catalog = JSON.parse(JSON.stringify(slashCatalog()));
const strip = <T extends { aliases?: unknown }>(c: T) => {
  const { aliases: _, ...rest } = c;
  return rest;
};

const INPUTS = [
  "", "hello", " /", "/", "/b", "/BW", "/z", "/zoom ", "/zoom in", "/fade in 1", "/fx", "/fx ", "/fx s", "/fx SPOT", "/fx led", "/fx glitter",
  "/fx /led", "/fx backdrop-word Big idea", "/bw;", "/bw; ", "/bw; /v", "/bw; v", "/bw;vig", "/noir; /fx ", "/noir; fx sp", "a; /b", "/cin", "/x", "/fx zzz",
  ...Object.keys(FX_ALIASES).map((a) => `/fx ${a}`),
  ...FX_CATALOG.map((f) => `/fx ${f.fx.slice(0, 3)}`),
];

test("phone suggestions equal core's for every input", () => {
  for (const input of INPUTS) {
    assert.equal(phone.isSlashCommand(input), isSlashCommand(input), input);
    const want = slashSuggestions(input).map((c) => c.name);
    const got = phone.slashSuggestions(catalog, input).map((c: { name: string }) => c.name);
    assert.deepEqual(got, want, `suggestions for ${JSON.stringify(input)}`);
  }
});

test("phone completion equals core's", () => {
  for (const input of INPUTS) {
    for (const c of slashSuggestions(input).slice(0, 5)) {
      const mine = [...catalog.commands, ...catalog.fx].find((x: { name: string }) => x.name === c.name);
      assert.equal(phone.completeSlash(input, strip(mine)), completeSlash(input, c), `${JSON.stringify(input)} → ${c.name}`);
    }
  }
});

test("no catalogue yet (Mac offline or older): no suggestions, no crash", () => {
  assert.deepEqual(phone.slashSuggestions(null, "/b"), []);
});

test("every alias names a real effect", () => {
  for (const f of catalog.fx) for (const a of f.aliases) assert.equal(FX_ALIASES[a], f.name.slice(3));
});
