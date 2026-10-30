// Which AI Director requests mean "make captions from the speech". Those are planned by the engine
// (transcribe locally, then word-timed captions), not by the model, which can't hear the audio.

const CAPTION = /\b(captions?|subtitles?|subtitel|takarir|transkrip\w*|transcri\w*)\b/i;
// Asking for new captions, not changing or removing existing ones ("ubah warna caption" goes to the model).
const MAKE = /\b(buat\w*|bikin\w*|tambah\w*|kasih|beri\w*|generate|create|add|make|auto\w*|otomatis)\b/i;
const REMOVE = /\b(hapus\w*|hilang\w*|buang|remove|delete|clear)\b/i;

export type CaptionStyleName = "bold" | "clean" | "boxed";

export function captionRequest(text: string): { style?: CaptionStyleName } | null {
  if (!CAPTION.test(text) || !MAKE.test(text) || REMOVE.test(text)) return null;
  const style: CaptionStyleName | undefined = /\bbold\b|\btebal\b/i.test(text) ? "bold" : /\bclean\b|\bbersih\b/i.test(text) ? "clean" : /\bbox(ed)?\b|\bkotak\b/i.test(text) ? "boxed" : undefined;
  return style ? { style } : {};
}
