import { isTauri } from "./api.ts";

const MEDIA_EXTENSIONS = ["mp4", "mov", "jpg", "jpeg", "png", "wav", "mp3"];

/** Native open dialog (desktop). The webview itself has no filesystem access. */
export async function pickMediaFiles(opts: { multiple?: boolean } = {}): Promise<string[]> {
  if (!isTauri()) {
    const raw = window.prompt("Absolute file path(s), one per line (browser dev mode):") ?? "";
    return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: opts.multiple ?? true,
    directory: false,
    title: "Import media",
    filters: [{ name: "Media (MP4, MOV, JPEG, PNG, WAV, MP3)", extensions: MEDIA_EXTENSIONS }],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** Files dropped from Finder onto the window. Returns an unsubscribe function. */
export async function onFileDrop(handler: (paths: string[]) => void, hover?: (over: boolean) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "enter" || e.payload.type === "over") hover?.(true);
    else hover?.(false);
    if (e.payload.type === "drop") handler(e.payload.paths);
  });
}

/** Native save dialog for exports. Returns null if the user cancelled. */
export async function pickExportPath(suggestedName: string): Promise<string | null> {
  const name = `${suggestedName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "ReelForge export"}.mp4`;
  if (!isTauri()) return window.prompt("Absolute export path (.mp4), browser dev mode:", `/tmp/${name}`) || null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ title: "Export video", defaultPath: name, filters: [{ name: "MP4 video (H.264 / AAC)", extensions: ["mp4"] }] });
  if (!path) return null;
  return path.toLowerCase().endsWith(".mp4") ? path : `${path}.mp4`;
}

/** Native save dialog for subtitles. */
export async function pickSrtPath(suggestedName: string): Promise<string | null> {
  const name = `${suggestedName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "captions"}.srt`;
  if (!isTauri()) return window.prompt("Absolute .srt path (browser dev mode):", `/tmp/${name}`) || null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ title: "Export subtitles", defaultPath: name, filters: [{ name: "SubRip subtitles", extensions: ["srt"] }] });
  if (!path) return null;
  return path.toLowerCase().endsWith(".srt") ? path : `${path}.srt`;
}
