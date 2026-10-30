export * from "./schema.ts";
export * from "./timebase.ts";
export * from "./errors.ts";
export { openDatabase, migrate, transaction, type Database } from "./db.ts";
export { MIGRATIONS, DEFAULT_TRACKS, type Migration } from "./migrations.ts";
export { resolveHome, resolveDbPath, resolveCacheDir, resolveModelsDir, ensureHome, DB_FILENAME } from "./paths.ts";
export { ProjectStore } from "./projects.ts";
export { AssetStore } from "./assets.ts";
export { TimelineStore } from "./timeline.ts";
export { applyOperations, canPlace, clipEnd, diffStates, type EditState, type TimelineDiff } from "./timeline-ops.ts";
export { parse } from "./validate.ts";
export { JobStore } from "./jobs.ts";
export * from "./render-plan.ts";
export { AnalysisStore } from "./analyses.ts";
export { generateCaptions, captionsToSrt, type CaptionGenOptions, type GeneratedCaption, type CaptionPlan } from "./captions.ts";
export { planCaptions } from "./captions-service.ts";
export { evenWords } from "./timeline-ops.ts";
export * from "./caption-layout.ts";
export { buildProjectContext, beatsOnTimeline, type ProjectContext } from "./context.ts";

import { TimelineOpSchema as _Ops } from "./schema.ts";
/** Every operation type the engine accepts (for planners and tool descriptions). */
export const OPERATION_TYPES: string[] = _Ops.options.map((o) => (o.shape.type as { value: string }).value);
export { ProposalStore, describeChanges, engineWarnings, type NewProposal } from "./proposals.ts";
