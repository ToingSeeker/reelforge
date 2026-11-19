// Slash commands in the phone's editor: the autocomplete only. What a command DOES is worked out on the Mac
// by the same code as the desktop (core slash.ts, via the `slash.plan` command), so this file never decides
// an edit. The suggestions are a copy of core's slashSuggestions/completeSlash working on the catalogue the
// Mac sends in studio.info; apps/remote/test/slash.test.ts keeps the two equal.

/** The chain splits on ";"; the part being typed is the last one. */
function lastPart(input) {
  const i = input.lastIndexOf(';');
  return i < 0 ? { before: '', part: input } : { before: input.slice(0, i + 1), part: input.slice(i + 1) };
}

export function isSlashCommand(input) {
  return input.trimStart().startsWith('/');
}

/**
 * Suggestions for the part being typed: command names while the first word is typed, then effect names
 * after "/fx ". Later parts of a chain may leave out the slash. `catalog` = studio.info's `slash`.
 */
export function slashSuggestions(catalog, input) {
  if (!catalog || !isSlashCommand(input)) return [];
  const { before, part } = lastPart(input);
  const p = part.trimStart();
  if (!before && !p.startsWith('/')) return [];
  const fx = /^\/?fx\s+(\S*)$/i.exec(p);
  if (fx) {
    const q = fx[1].toLowerCase().replace(/^\//, '');
    const alias = catalog.fx.find((c) => c.name.slice(3) === q || c.aliases.includes(q));
    return catalog.fx.filter((c) => c.name.slice(3).startsWith(fx[1].toLowerCase()) || c === alias);
  }
  const m = /^\/?(\S*)$/.exec(p);
  if (!m) return [];
  const word = m[1].toLowerCase();
  return catalog.commands.filter((c) => c.name.startsWith(word));
}

/** The input with the part being typed replaced by the picked suggestion (and a space if it takes arguments). */
export function completeSlash(input, c) {
  const { before } = lastPart(input);
  const takesArgs = c.usage.length > c.name.length + 1;
  return `${before}${before ? ' ' : ''}/${c.name}${takesArgs ? ' ' : ''}`;
}
