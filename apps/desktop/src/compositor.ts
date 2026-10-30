// Live preview: composites the canonical RenderPlan on a canvas from proxy
// media, with WebAudio for sound. It uses the same pure functions as the FFmpeg
// export (activeLayers, pictureAlpha, placement, audioGain), so what you see
// while editing matches the render; the "Rendered" mode is the exact output.

import { activeLayers, audioGain, pictureAlpha, placement, type PlanSegment, type RenderPlan } from "@reelforge/core/render-plan";

export interface CompositorSources {
  mediaUrl: (assetId: string) => string;
}

const PRELOAD_FRAMES = 45;
const KEEP_FRAMES = 120;
const DRIFT_FRAMES = 3;

export class Compositor {
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #plan: RenderPlan | null = null;
  #sources: CompositorSources;
  #videos = new Map<string, HTMLVideoElement>(); // by clipId
  #images = new Map<string, HTMLImageElement>(); // by assetId
  #audioCtx: AudioContext | null = null;
  #buffers = new Map<string, Promise<AudioBuffer | null>>(); // by assetId
  #playing: { f0: number; t0: number; nodes: AudioScheduledSourceNode[]; raf: number } | null = null;
  #frame = 0;
  #drawToken = 0;
  onFrame: ((frame: number) => void) | null = null;
  onEnded: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, sources: CompositorSources) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d")!;
    this.#sources = sources;
  }

  get fps(): number {
    return this.#plan ? this.#plan.fps.num / this.#plan.fps.den : 30;
  }

  setPlan(plan: RenderPlan | null, size: { width: number; height: number }) {
    this.#plan = plan;
    if (this.#canvas.width !== size.width || this.#canvas.height !== size.height) {
      this.#canvas.width = size.width;
      this.#canvas.height = size.height;
    }
    // Drop media for clips that no longer exist.
    const live = new Set(plan?.layers.flat().map((s) => s.clipId) ?? []);
    for (const [id, v] of this.#videos) if (!live.has(id)) this.#release(id, v);
    if (plan) for (const seg of plan.audio) void this.#buffer(seg.assetId);
    if (this.#playing) {
      // Re-schedule audio against the new plan without a visible hiccup.
      const f = this.#currentPlayFrame();
      this.#stopAudio();
      this.#playing.f0 = f;
      this.#playing.t0 = this.#audio().currentTime;
      void this.#scheduleAudio(f);
    } else {
      this.seek(this.#frame);
    }
  }

  /** Show exactly `frame` (paused). */
  seek(frame: number) {
    this.#frame = frame;
    if (this.#playing) return;
    const token = ++this.#drawToken;
    const waits: Promise<void>[] = [];
    for (const seg of this.#active(frame)) {
      const v = this.#videoFor(seg);
      if (!v) continue;
      const t = this.#sourceTime(seg, frame);
      if (Math.abs(v.currentTime - t) > 0.5 / this.fps || v.readyState < 2) {
        v.currentTime = t;
        waits.push(new Promise((r) => v.addEventListener("seeked", () => r(), { once: true })));
      }
    }
    this.#prepare(frame);
    this.#draw(frame);
    if (waits.length) void Promise.all(waits).then(() => token === this.#drawToken && this.#draw(frame));
  }

  async play(from: number) {
    if (!this.#plan || this.#playing) return;
    const ctx = this.#audio();
    if (ctx.state === "suspended") await ctx.resume();
    // Make sure sound is decoded before the clock starts, so audio and picture start together.
    await Promise.all(this.#plan.audio.map((s) => this.#buffer(s.assetId)));
    const start = from >= this.#plan.totalFrames ? 0 : from;
    this.#playing = { f0: start, t0: ctx.currentTime + 0.05, nodes: [], raf: 0 };
    void this.#scheduleAudio(start);
    const tick = () => {
      if (!this.#playing || !this.#plan) return;
      const f = this.#currentPlayFrame();
      if (f >= this.#plan.totalFrames) {
        this.pause();
        this.#frame = this.#plan.totalFrames;
        this.onFrame?.(this.#plan.totalFrames);
        this.onEnded?.();
        return;
      }
      this.#frame = f;
      this.#syncVideos(f);
      this.#draw(f);
      this.onFrame?.(f);
      this.#playing.raf = requestAnimationFrame(tick);
    };
    this.#playing.raf = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.#playing) return;
    cancelAnimationFrame(this.#playing.raf);
    this.#stopAudio();
    this.#playing = null;
    for (const v of this.#videos.values()) v.pause();
  }

  dispose() {
    this.pause();
    for (const [id, v] of this.#videos) this.#release(id, v);
    void this.#audioCtx?.close();
  }

  // --- internals -----------------------------------------------------------

  #audio(): AudioContext {
    this.#audioCtx ??= new AudioContext({ latencyHint: "interactive" });
    return this.#audioCtx;
  }

  #currentPlayFrame(): number {
    const p = this.#playing!;
    return p.f0 + Math.max(0, Math.floor((this.#audio().currentTime - p.t0) * this.fps + 1e-6));
  }

  #active(frame: number): PlanSegment[] {
    return this.#plan ? activeLayers(this.#plan, frame) : [];
  }

  #sourceTime(seg: PlanSegment, frame: number): number {
    // Middle of the frame, so the decoder lands on it rather than the one before.
    return (seg.renderSourceIn + (frame - seg.renderStart) + 0.5) / this.fps;
  }

  #videoFor(seg: PlanSegment): HTMLVideoElement | null {
    if (this.#plan?.sources[seg.assetId]?.kind !== "video") return null;
    let v = this.#videos.get(seg.clipId);
    if (!v) {
      v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.muted = true; // sound comes from WebAudio, which follows the plan's audio tracks
      v.playsInline = true;
      v.preload = "auto";
      v.src = this.#sources.mediaUrl(seg.assetId);
      v.addEventListener("loadeddata", () => !this.#playing && this.#draw(this.#frame));
      this.#videos.set(seg.clipId, v);
    }
    return v;
  }

  #imageFor(assetId: string): HTMLImageElement {
    let img = this.#images.get(assetId);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = this.#sources.mediaUrl(assetId);
      img.addEventListener("load", () => !this.#playing && this.#draw(this.#frame));
      this.#images.set(assetId, img);
    }
    return img;
  }

  #release(id: string, v: HTMLVideoElement) {
    v.pause();
    v.removeAttribute("src");
    v.load();
    this.#videos.delete(id);
  }

  /** Warm up clips about to start; free ones far away. */
  #prepare(frame: number) {
    if (!this.#plan) return;
    for (const layer of this.#plan.layers) {
      for (const seg of layer) {
        const near = seg.renderStart - PRELOAD_FRAMES <= frame && frame < seg.renderEnd + KEEP_FRAMES;
        const existing = this.#videos.get(seg.clipId);
        if (near) {
          const v = this.#videoFor(seg);
          if (v && frame < seg.renderStart && v.paused && Math.abs(v.currentTime - this.#sourceTime(seg, seg.renderStart)) > 0.5 / this.fps) {
            v.currentTime = this.#sourceTime(seg, seg.renderStart);
          }
          if (this.#plan.sources[seg.assetId]?.kind === "image") this.#imageFor(seg.assetId);
        } else if (existing) {
          this.#release(seg.clipId, existing);
        }
      }
    }
  }

  #syncVideos(frame: number) {
    const active = new Set<string>();
    for (const seg of this.#active(frame)) {
      const v = this.#videoFor(seg);
      if (!v) continue;
      active.add(seg.clipId);
      const t = this.#sourceTime(seg, frame);
      if (Math.abs(v.currentTime - t) > DRIFT_FRAMES / this.fps) v.currentTime = t;
      if (v.paused) void v.play().catch(() => {});
    }
    for (const [id, v] of this.#videos) if (!active.has(id) && !v.paused) v.pause();
    if (frame % 10 === 0) this.#prepare(frame);
  }

  #draw(frame: number) {
    const plan = this.#plan;
    const ctx = this.#ctx;
    const cw = this.#canvas.width;
    const ch = this.#canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    if (!plan) return;
    const k = cw / plan.width; // project → canvas pixels
    for (const seg of activeLayers(plan, frame)) {
      const alpha = pictureAlpha(seg, frame);
      if (alpha <= 0) continue;
      const kind = plan.sources[seg.assetId]?.kind;
      let src: CanvasImageSource | null = null;
      let sw = 0;
      let sh = 0;
      if (kind === "video") {
        const v = this.#videos.get(seg.clipId);
        if (v && v.readyState >= 2) [src, sw, sh] = [v, v.videoWidth, v.videoHeight];
      } else if (kind === "image") {
        const img = this.#imageFor(seg.assetId);
        if (img.complete && img.naturalWidth) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
      }
      if (!src || !sw || !sh) continue;
      const p = placement(seg, frame, sw, sh, plan.width, plan.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.translate(p.cx, p.cy);
      ctx.rotate(p.rotation);
      ctx.drawImage(src, p.sx, p.sy, p.sw, p.sh, -p.dw / 2, -p.dh / 2, p.dw, p.dh);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  #buffer(assetId: string): Promise<AudioBuffer | null> {
    let b = this.#buffers.get(assetId);
    if (!b) {
      b = fetch(this.#sources.mediaUrl(assetId))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`audio ${r.status}`))))
        .then((data) => this.#audio().decodeAudioData(data))
        .catch(() => null);
      this.#buffers.set(assetId, b);
    }
    return b;
  }

  async #scheduleAudio(from: number) {
    const plan = this.#plan;
    const play = this.#playing;
    if (!plan || !play) return;
    const ctx = this.#audio();
    const fps = this.fps;
    for (const seg of plan.audio) {
      if (seg.renderEnd <= from) continue;
      const buffer = await this.#buffer(seg.assetId);
      if (!buffer || this.#playing !== play) continue;
      const first = Math.max(from, seg.renderStart);
      const when = play.t0 + (first - play.f0) / fps;
      const offset = (seg.renderSourceIn + (first - seg.renderStart)) / fps;
      const dur = (seg.renderEnd - first) / fps;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      // audioGain is piecewise linear between these frames; ramp between them.
      const p = seg.props;
      const end = seg.start + seg.duration;
      const points = [
        seg.renderStart, seg.start - seg.inH, seg.start + seg.inH, seg.start, seg.start + p.fadeIn,
        end - p.fadeOut, end, end - seg.outH, end + seg.outH, seg.renderEnd - 1e-3,
      ]
        .filter((f) => f >= first && f <= seg.renderEnd)
        .sort((a, b) => a - b);
      gain.gain.setValueAtTime(audioGain(seg, first), Math.max(ctx.currentTime, when));
      for (const f of points) gain.gain.linearRampToValueAtTime(audioGain(seg, f), play.t0 + (f - play.f0) / fps);
      src.connect(gain).connect(ctx.destination);
      const lateBy = Math.max(0, ctx.currentTime - when);
      src.start(Math.max(ctx.currentTime, when), offset + lateBy, Math.max(0, dur - lateBy));
      play.nodes.push(src);
    }
  }

  #stopAudio() {
    for (const n of this.#playing?.nodes ?? []) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.#playing) this.#playing.nodes = [];
  }
}
