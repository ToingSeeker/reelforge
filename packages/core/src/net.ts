// Telling the public internet from this machine and its network, for anything that connects to a
// URL someone else chose (a download link, a phone's push endpoint). The check runs on the resolved
// addresses at connect time, so DNS rebinding can't swap a public answer for a private one.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

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

/** A `lookup` for http(s) requests that refuses any name resolving to a non-public address. */
export function publicOnlyLookup(refuse: (hostname: string) => Error): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return (callback as (e: Error) => void)(err);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (!list.length || bad) {
        return (callback as (e: Error) => void)(refuse(hostname));
      }
      if ((options as { all?: boolean }).all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
      (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
    });
  };
}
