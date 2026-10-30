import { useCallback, useEffect, useRef, useState } from "react";
import type { Analysis, AnalysisKind } from "@reelforge/core/schema";
import type { Client } from "./api.ts";
import type { Notify } from "./editor.ts";

export type AnalysisMap = ReadonlyMap<string, Analysis[]>;

/** Analysis status for every asset in the project; polls quickly while anything is running. */
export function useAnalyses(client: Client | null, projectId: string | null, notify: Notify) {
  const [map, setMap] = useState<AnalysisMap>(new Map());
  const busy = useRef(false);
  const tick = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    if (!client || !projectId) return setMap(new Map());
    try {
      const r = await client.analyses(projectId);
      const m = new Map(Object.entries(r));
      busy.current = [...m.values()].flat().some((a) => a.state === "queued" || a.state === "running");
      setMap(m);
    } catch {
      /* engine offline: the top bar already says so */
    }
  }, [client, projectId]);
  tick.current = load;

  useEffect(() => {
    void load();
    let t: number;
    const loop = () => {
      t = window.setTimeout(async () => {
        if (document.visibilityState === "visible") await tick.current();
        loop();
      }, busy.current ? 1000 : 5000);
    };
    loop();
    return () => window.clearTimeout(t);
  }, [load]);

  const analyze = useCallback(
    async (assetId: string, kinds: AnalysisKind[], language?: string) => {
      if (!client || !projectId) return;
      try {
        await client.analyze(projectId, assetId, kinds, language);
        busy.current = true;
        await load();
      } catch (e) {
        notify("error", e instanceof Error ? e.message : String(e));
      }
    },
    [client, projectId, load, notify],
  );

  return { map, analyze, reload: load };
}

export function analysisOf<K extends AnalysisKind>(map: AnalysisMap, assetId: string, kind: K): Analysis<K> | undefined {
  return map.get(assetId)?.find((a) => a.kind === kind) as Analysis<K> | undefined;
}
