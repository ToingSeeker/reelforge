import type { AnalysisKind, Asset, Clip, Timeline } from "@reelforge/core/schema";
import { analysisOf, type AnalysisMap } from "../analyses.ts";
import { Icon } from "../icons.tsx";

interface Props {
  timeline: Timeline;
  clip: Clip | null;
  analyses: AnalysisMap;
  snapToBeats: boolean;
  onSnapToBeats: (v: boolean) => void;
  onAnalyze: (asset: Asset, kinds: AnalysisKind[]) => void;
}

/** What media intelligence knows about the selected clip's source. */
export function AudioPanel({ timeline, clip, analyses, snapToBeats, onSnapToBeats, onAnalyze }: Props) {
  const asset = clip ? timeline.assets.find((a) => a.id === clip.assetId) : undefined;
  const beats = asset ? analysisOf(analyses, asset.id, "beats") : undefined;
  const scenes = asset ? analysisOf(analyses, asset.id, "scenes") : undefined;
  const tr = asset ? analysisOf(analyses, asset.id, "transcript") : undefined;
  const state = (a: { state: string; progress: number } | undefined) =>
    !a ? "not analysed" : a.state === "running" ? `running ${Math.round(a.progress * 100)}%` : a.state === "queued" ? "queued" : a.state;

  return (
    <section className="rf-panel rf-library" aria-label="Audio and analysis">
      <div className="rf-panel-head">
        <h2>Beats &amp; analysis</h2>
      </div>
      <div className="rf-captions-scroll">
        <label className="rf-check rf-snap-beats">
          <input type="checkbox" checked={snapToBeats} onChange={(e) => onSnapToBeats(e.target.checked)} /> Snap edits to beats and scene cuts
        </label>
        {!asset ? (
          <p className="rf-hint rf-pad">Select a clip to see its beats, scenes and transcript. Analysis runs on this Mac.</p>
        ) : (
          <>
            <div className="rf-an-head">
              <strong>{asset.filename}</strong>
            </div>
            {asset.hasAudio && (
              <section className="rf-cap-group">
                <h3>Beats</h3>
                {beats?.result ? (
                  <p>
                    {beats.result.confidence >= 0.3 ? (
                      <>
                        <strong className="rf-big">{Math.round(beats.result.bpm)} BPM</strong> · {beats.result.beatsUs.length} beats · confidence{" "}
                        {Math.round(beats.result.confidence * 100)}%
                      </>
                    ) : (
                      "No clear beat in this audio."
                    )}
                  </p>
                ) : (
                  <p className="rf-hint">{state(beats)}</p>
                )}
                <button className="rf-btn" onClick={() => onAnalyze(asset, ["beats"])}>
                  <Icon name="audio" size={14} /> {beats ? "Detect again" : "Detect beats"}
                </button>
              </section>
            )}
            {asset.kind === "video" && (
              <section className="rf-cap-group">
                <h3>Scenes</h3>
                <p className={scenes?.result ? "" : "rf-hint"}>
                  {scenes?.result ? `${scenes.result.cuts.length} cut${scenes.result.cuts.length === 1 ? "" : "s"} detected` : state(scenes)}
                </p>
                <button className="rf-btn" onClick={() => onAnalyze(asset, ["scenes"])}>
                  <Icon name="film" size={14} /> {scenes ? "Detect again" : "Detect scenes"}
                </button>
              </section>
            )}
            {asset.hasAudio && (
              <section className="rf-cap-group">
                <h3>Transcript {tr?.result ? <span className="rf-hint">({tr.result.language})</span> : null}</h3>
                {tr?.result ? <p className="rf-transcript">{tr.result.text || "No speech found."}</p> : <p className="rf-hint">{state(tr)}</p>}
                <button className="rf-btn" onClick={() => onAnalyze(asset, ["transcript"])}>
                  <Icon name="text" size={14} /> {tr ? "Transcribe again" : "Transcribe"}
                </button>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
