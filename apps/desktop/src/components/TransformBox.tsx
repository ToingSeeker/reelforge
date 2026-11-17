import { useEffect, useRef, useState } from "react";
import type { ClipPropsPatch, Timeline } from "@reelforge/core/schema";
import { activeLayers, placement, type RenderPlan } from "@reelforge/core/render-plan";

interface Props {
  timeline: Timeline;
  plan: RenderPlan;
  frame: number;
  clipId: string;
  /** The .rf-frame element: pointer deltas are measured against its on-screen size. */
  frameEl: HTMLElement | null;
  onDraft: (props: ClipPropsPatch | null) => void;
  onCommit: (props: ClipPropsPatch, label: string) => void;
}

type Drag =
  | { kind: "move"; px: number; py: number; x: number; y: number }
  | { kind: "scale"; cx: number; cy: number; dist: number; scale: number };

const CORNERS = ["nw", "ne", "sw", "se"] as const;
/** Snap the centre onto the frame's centre lines within this fraction of the frame. */
const SNAP = 0.012;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 10000) / 10000;

/**
 * On-canvas handles for the selected clip: drag the box to move it, drag a corner to scale around the
 * centre. Uses the same placement maths as the compositor and the export, so the box sits exactly on the
 * picture. Edits go through the same draft/commit path as the Inspector (one undo step per drag).
 */
export function TransformBox({ timeline, plan, frame, clipId, frameEl, onDraft, onCommit }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const last = useRef<ClipPropsPatch | null>(null);

  const seg = activeLayers(plan, frame).find((s) => s.clipId === clipId);
  const asset = seg ? timeline.assets.find((a) => a.id === seg.assetId) : undefined;

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const r = frameEl?.getBoundingClientRect();
      if (!r) return;
      if (drag.kind === "move") {
        let x = drag.x + (e.clientX - drag.px) / r.width;
        let y = drag.y + (e.clientY - drag.py) / r.height;
        if (!e.altKey) {
          if (Math.abs(x) < SNAP) x = 0;
          if (Math.abs(y) < SNAP) y = 0;
        }
        last.current = { x: round(clamp(x, -2, 2)), y: round(clamp(y, -2, 2)) };
      } else {
        const d = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy);
        let scale = drag.scale * (d / Math.max(1, drag.dist));
        if (!e.altKey && Math.abs(scale - 1) < 0.02) scale = 1;
        last.current = { scale: round(clamp(scale, 0.05, 10)) };
      }
      onDraft(last.current);
    };
    const end = (commit: boolean) => {
      const patch = last.current;
      last.current = null;
      setDrag(null);
      if (commit && patch) onCommit(patch, drag.kind === "move" ? "Move clip" : "Scale clip");
      else onDraft(null);
    };
    const up = () => end(true);
    const key = (e: KeyboardEvent) => e.key === "Escape" && end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
    };
  }, [drag, frameEl, onDraft, onCommit]);

  if (!seg || !asset?.width || !asset.height) return null;
  const W = plan.width;
  const H = plan.height;
  const p = placement(seg, frame, asset.width, asset.height, W, H);
  const animated = seg.props.xEnd !== null || seg.props.yEnd !== null || seg.props.scaleEnd !== null;

  const start = (e: React.PointerEvent, kind: Drag["kind"]) => {
    if (e.button !== 0 || animated) return;
    e.preventDefault();
    e.stopPropagation();
    const r = frameEl?.getBoundingClientRect();
    if (!r) return;
    if (kind === "move") {
      setDrag({ kind, px: e.clientX, py: e.clientY, x: seg.props.x, y: seg.props.y });
    } else {
      const cx = r.left + (p.cx / W) * r.width;
      const cy = r.top + (p.cy / H) * r.height;
      setDrag({ kind, cx, cy, dist: Math.hypot(e.clientX - cx, e.clientY - cy), scale: seg.props.scale });
    }
  };

  return (
    <div
      className={`rf-transform${drag ? " is-dragging" : ""}${animated ? " is-locked" : ""}`}
      style={{
        left: `${(p.cx / W) * 100}%`,
        top: `${(p.cy / H) * 100}%`,
        width: `${(p.dw / W) * 100}%`,
        height: `${(p.dh / H) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${p.rotation}rad)`,
      }}
      title={animated ? "This clip pans or zooms over time; edit its motion in the Inspector" : "Drag to move · drag a corner to scale · Alt: no snapping"}
      onPointerDown={(e) => start(e, "move")}
    >
      {!animated &&
        CORNERS.map((c) => (
          <span key={c} className={`rf-transform-handle is-${c}`} aria-hidden="true" onPointerDown={(e) => start(e, "scale")} />
        ))}
    </div>
  );
}
