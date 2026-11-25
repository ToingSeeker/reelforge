#!/usr/bin/env node
import { main } from "../src/main.ts";

// `reelforge … | head` closes the pipe before we finish writing: the reader is done, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

process.exitCode = await main(process.argv.slice(2));
