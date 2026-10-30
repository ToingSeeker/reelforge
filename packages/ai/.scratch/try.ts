import { openDatabase, ProposalStore } from "../../core/src/index.ts";
import { propose, OllamaProvider } from "../src/index.ts";
const db = openDatabase("/Users/shuttershoot/reelforge/.reelforge/m1/reelforge.db");
const pid = process.argv[2]!;
const model = process.argv[3] ?? "qwen3.5:27b";
const t0 = Date.now();
try {
  const p = await propose(db, pid, new OllamaProvider(), { model, instruction: process.argv[4] ?? "Tambahkan fade in 0,5 detik di klip video pertama, dissolve 0,5 detik antar klip video, dan zoom pelan (Ken Burns) di klip terakhir." });
  console.log(JSON.stringify({ secs: ((Date.now() - t0) / 1000).toFixed(1), summary: p.summary, warnings: p.warnings, ops: p.operations.map((o, i) => `${o.type} ${JSON.stringify("props" in o ? o.props : "")} — ${p.explanations[i]}`), changes: p.changes.map((c) => `${c.kind} ${c.label}: ${c.before} → ${c.after}`), attempts: (p.usage as any).attempts.length }, null, 1));
  new ProposalStore(db).reject(p.id, "cli");
} catch (e) { console.log("FAILED after", ((Date.now() - t0) / 1000).toFixed(1), "s:", (e as Error).message); }
