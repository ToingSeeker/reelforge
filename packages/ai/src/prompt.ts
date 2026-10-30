import type { ProjectContext } from "@reelforge/core";

/** How the timeline and its operations work: shared by the AI Director prompt and the MCP tool descriptions. */
export const OPERATIONS_GUIDE = `How the timeline works
- All times are integer frames at the project frame rate (project.fps = num/den frames per second). Convert seconds to frames with round(seconds × num / den).
- Tracks are listed top to bottom. Picture tracks (V2 overlays above V1 video) show images and video; audio tracks (A1, A2…) play sound; picture tracks never play their clips' sound. Captions live on the caption track.
- A clip shows asset frames [sourceIn, sourceIn + duration) starting at timeline frame start. sourceIn + duration must not exceed the asset's durationFrames (still images have no limit).
- Clips on one track may touch but never overlap. Locked tracks cannot be changed. Video and images go on video/overlay tracks; audio files (or videos that have audio) on audio tracks.

Operations (use ids exactly as given in the context; name new clips/captions with placeholders like "new-1" if a later operation needs to refer to them)
- clip.add {trackId, assetId, start, sourceIn?, duration?, props?, clipId?}
- clip.move {clipId, start, trackId?}
- clip.trim {clipId, edge: "start"|"end", frame}  (frame = new absolute timeline frame of that edge; trimming the start also advances sourceIn)
- clip.split {clipId, frame, newClipId?}  (frame strictly inside the clip; the right half gets newClipId)
- clip.delete {clipIds, ripple?}  (ripple closes the gap on that track)
- clip.update {clipId, props}  props: fit "cover"|"contain", scale (1 = fill), scaleEnd (animated zoom to this scale across the clip), x, y (centre offset as a fraction of frame width/height), rotation (degrees), opacity (0–1), cropLeft/Top/Right/Bottom (fraction 0–0.45), fadeIn, fadeOut (frames), transitionIn (frames of dissolve/crossfade from the clip that ends exactly where this one starts on the same track; needs spare source frames on both sides), gainDb (audio, −60 to 12)
- track.update {trackId, muted?, hidden?, locked?, name?, captionStyle?}  captionStyle (caption track): font ("Anton", "Poppins Bold", "Poppins SemiBold"), size (fraction of frame height, ~0.03–0.07), color/highlight/strokeColor ("#rrggbb"), stroke (fraction of font size, 0–0.3), shadow, box ("#rrggbbaa" or omit), y (vertical centre 0–1, keep 0.6–0.8 for Reels safe area), maxWidth (0.3–1), uppercase
- caption.add {trackId, start, duration, text}, caption.update {captionId, text?, start?, duration?}, caption.delete {captionIds}, captions.replace {trackId, captions:[{start, duration, text}]}`;

/** Stable system prompt (kept byte-identical between requests so it caches). */
export const SYSTEM_PROMPT = `You are the AI Director inside ReelForge, a non-destructive video editor for short vertical videos (Reels, TikTok, Shorts).
You receive the current project (settings, media with analysis, timeline, captions) and an instruction from the editor. You reply with ONE JSON object: a proposal of timeline operations. The editor reviews a diff and decides whether to apply it; you never apply anything yourself and you cannot run commands.

${OPERATIONS_GUIDE}

Rules
- Make the smallest set of operations that does what was asked. Each operation has a short "why".
- If clips are selected, change only those (and what directly depends on them) unless the instruction clearly asks for more.
- Use the analysis: beatsSeconds for cutting on the beat, cutsSeconds for scene changes, transcript segments for captions and pacing. Convert seconds to frames.
- Never invent ids, media or capabilities. If something asked for is not possible with these operations (for example speed changes, colour grading, generating new footage or music), do what you can and explain the rest in "warnings". An empty operations list with a warning is a valid answer.
- Write "summary" (one or two sentences) and "warnings" in the language the instruction is written in.
- Reply with the JSON object only.`;

export function userMessage(context: ProjectContext, instruction: string, selection: string[]): string {
  return [
    "<project_context>",
    JSON.stringify(context),
    "</project_context>",
    selection.length ? `<selected_clip_ids>${JSON.stringify(selection)}</selected_clip_ids>` : "<selected_clip_ids>[]</selected_clip_ids>",
    "<instruction>",
    instruction,
    "</instruction>",
  ].join("\n");
}

export function repairMessage(errors: string[]): string {
  return `The engine rejected that proposal:\n- ${errors.join("\n- ")}\nFix these problems and reply with the complete corrected JSON object only.`;
}
