// Downloads a remote client asks for (a ChatGPT attachment's download_url, a link the user pasted).
// The engine runs on the user's machine, so a URL must never reach the machine itself or its network:
// https only, every resolved address checked against private ranges (also after each redirect, and at
// connect time so DNS rebinding can't swap the address), with a size cap and a timeout.

import { createWriteStream, rmSync } from "node:fs";
import { get } from "node:https";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isPrivateAddress, publicOnlyLookup, ReelForgeError } from "@reelforge/core";

export { isPrivateAddress };

const publicOnly = publicOnlyLookup((hostname) => new ReelForgeError("VALIDATION_ERROR", `refusing to download from ${hostname}: it resolves to a private or local address`));

export interface DownloadResult {
  bytes: number;
  /** File name from Content-Disposition, if the server sent one. */
  fileName?: string;
  contentType?: string;
}

export async function downloadToFile(url: string, dest: string, opts: { maxBytes: number; timeoutMs?: number; maxRedirects?: number }): Promise<DownloadResult> {
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new ReelForgeError("VALIDATION_ERROR", "not a valid URL");
    }
    if (u.protocol !== "https:") throw new ReelForgeError("VALIDATION_ERROR", "only https:// links can be downloaded");
    if (u.username || u.password) throw new ReelForgeError("VALIDATION_ERROR", "links with a user name or password are not accepted");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host)) throw new ReelForgeError("VALIDATION_ERROR", "refusing to download from a private or local address");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new ReelForgeError("VALIDATION_ERROR", "refusing to download from a local host name");

    const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = get(u, { lookup: publicOnly, headers: { "user-agent": "ReelForge", accept: "*/*" }, timeout: opts.timeoutMs ?? 60_000 }, resolve);
      req.on("timeout", () => req.destroy(new ReelForgeError("UNAVAILABLE", "the download timed out")));
      req.on("error", reject);
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, u).toString();
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new ReelForgeError("UNAVAILABLE", `the download failed: the server answered ${status}`);
    }
    const declared = Number(res.headers["content-length"] ?? NaN);
    if (declared > opts.maxBytes) {
      res.destroy();
      throw new ReelForgeError("VALIDATION_ERROR", `the file is larger than the ${Math.round(opts.maxBytes / 2 ** 20)} MB limit`);
    }
    let bytes = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > opts.maxBytes) return cb(new ReelForgeError("VALIDATION_ERROR", `the file is larger than the ${Math.round(opts.maxBytes / 2 ** 20)} MB limit`));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res, cap, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
    } catch (e) {
      rmSync(dest, { force: true });
      throw e;
    }
    const disposition = String(res.headers["content-disposition"] ?? "");
    const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    return {
      bytes,
      ...(name ? { fileName: safeDecode(name) } : {}),
      ...(res.headers["content-type"] ? { contentType: String(res.headers["content-type"]) } : {}),
    };
  }
  throw new ReelForgeError("UNAVAILABLE", "too many redirects");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
