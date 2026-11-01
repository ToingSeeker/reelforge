// The OFL fonts ReelForge already ships for captions (assets/fonts). Imported as files so both
// bundlers that load these compositions (Remotion's webpack for renders, Vite for the desktop
// preview) emit them and hand us a URL; the export and the preview then draw the same glyphs.
import { continueRender, delayRender } from "remotion";
import antonUrl from "../../../assets/fonts/Anton-Regular.ttf";
import poppinsBoldUrl from "../../../assets/fonts/Poppins-Bold.ttf";
import poppinsSemiUrl from "../../../assets/fonts/Poppins-SemiBold.ttf";

export const DISPLAY = "RF Anton";
export const BODY = "RF Poppins";

const FACES: { family: string; url: string; weight: string }[] = [
  { family: DISPLAY, url: antonUrl, weight: "400" },
  { family: BODY, url: poppinsBoldUrl, weight: "700" },
  { family: BODY, url: poppinsSemiUrl, weight: "600" },
];

let loading: Promise<void> | null = null;

/** Load the faces once per page; a render waits (delayRender) so no frame uses a fallback font. */
export function ensureFonts(): void {
  if (loading || typeof document === "undefined") return;
  const handle = delayRender("ReelForge fonts");
  loading = Promise.all(
    FACES.map(async (f) => {
      const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight });
      document.fonts.add(await face.load());
    }),
  )
    .catch((e) => console.error("font load failed", e))
    .then(() => continueRender(handle));
}
