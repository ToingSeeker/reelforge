import {
  AnalysisStore,
  buildProjectContext,
  isReelForgeError,
  OPERATION_TYPES,
  ProposalStore,
  ReelForgeError,
  TimelineStore,
  type AIProposal,
  type Database,
} from "@reelforge/core";
import { MODEL_OUTPUT_SCHEMA, parseModelOutput } from "./output-schema.ts";
import { repairMessage, SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import type { ChatTurn, PlannerProvider } from "./providers/types.ts";

export interface ProposeInput {
  instruction: string;
  model: string;
  selection?: string[];
}

const MAX_ATTEMPTS = 2;

/**
 * Ask a provider for an edit proposal. The reply is parsed against the
 * operation schema and dry-run against the current timeline; if either fails,
 * the errors go back to the model once. Only a proposal that passes is stored.
 */
export async function propose(db: Database, projectId: string, provider: PlannerProvider, input: ProposeInput, opts: { signal?: AbortSignal } = {}): Promise<AIProposal> {
  const instruction = input.instruction.trim();
  if (!instruction || instruction.length > 4000) throw new ReelForgeError("VALIDATION_ERROR", "the instruction must be 1–4000 characters");
  const proposals = new ProposalStore(db);
  if (provider.external && !proposals.consent(projectId)) {
    throw new ReelForgeError("CONSENT_REQUIRED", `sending this project's context to ${provider.id} needs your permission first`, { provider: provider.id });
  }
  const tl = new TimelineStore(db).get(projectId);
  const selection = [...new Set(input.selection ?? [])];
  const unknown = selection.filter((id) => !tl.clips.some((c) => c.id === id));
  if (unknown.length) throw new ReelForgeError("VALIDATION_ERROR", "selected clips are not on the timeline", { unknown });

  const context = buildProjectContext(tl, new AnalysisStore(db).forProject(projectId), OPERATION_TYPES);
  const turns: ChatTurn[] = [{ role: "user", content: userMessage(context, instruction, selection) }];
  const usage: Record<string, unknown>[] = [];
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await provider.complete({ model: input.model, system: SYSTEM_PROMPT, turns, schema: MODEL_OUTPUT_SCHEMA, ...(opts.signal ? { signal: opts.signal } : {}) });
    usage.push({ attempt, model: reply.model, ...reply.usage });
    const plan = parseModelOutput(reply.text);
    let errors = plan.errors;
    if (!errors.length) {
      const warnings = [...plan.warnings];
      if (selection.length) {
        const touched = plan.operations.flatMap((o) => ("clipId" in o ? [o.clipId] : "clipIds" in o ? o.clipIds : [])).filter((id): id is string => !!id);
        const outside = [...new Set(touched)].filter((id) => tl.clips.some((c) => c.id === id) && !selection.includes(id));
        if (outside.length) warnings.push(`Also changes ${outside.length} clip(s) outside your selection.`);
      }
      try {
        return proposals.create(projectId, {
          instruction,
          selection,
          provider: provider.id,
          model: reply.model,
          summary: plan.summary || "Proposed edit",
          operations: plan.operations,
          explanations: plan.explanations,
          warnings,
          usage: { attempts: usage },
        });
      } catch (e) {
        if (!isReelForgeError(e) || e.code !== "VALIDATION_ERROR") throw e;
        const issues = (e.details?.issues as { path: string; message: string }[] | undefined)?.map((i) => `${i.path}: ${i.message}`);
        errors = [issues?.length ? issues.join("; ") : e.message];
      }
    }
    lastErrors = errors;
    turns.push({ role: "assistant", content: reply.text }, { role: "user", content: repairMessage(errors) });
  }
  throw new ReelForgeError("VALIDATION_ERROR", `the AI's proposal was invalid and the timeline was not changed: ${lastErrors.join(" | ")}`, { errors: lastErrors });
}
