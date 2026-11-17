// Downloads a remote client asks for (a ChatGPT attachment's download_url, a link the user pasted).
// The engine runs on the user's machine, so a URL must never reach the machine itself or its network:
// https only, every resolved address checked against private ranges (also after each redirect, and at
// connect time so DNS rebinding can't swap the address), with a size cap and a timeout.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createWriteStream, rmSync } from "node:fs";
import { get } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { ReelForgeError } from "@reelforge/core";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** True for loopback, private, link-local and other addresses that are not the public internet. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an address at all: refuse
}

const publicOnly: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) {
      return (callback as (e: Error) => void)(new ReelForgeError("VALIDATION_ERROR", `refusing to download from ${hostname}: it resolves to a private or local address`));
    }
    if ((options as { all?: boolean }).all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

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
