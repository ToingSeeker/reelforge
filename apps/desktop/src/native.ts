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
