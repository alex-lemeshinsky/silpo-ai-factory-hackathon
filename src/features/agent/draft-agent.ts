import {
  DraftProposalSchema,
  InvalidProposalError,
  validateProposal,
  type DraftAgentInput,
  type DraftProposal,
  type DraftProposalItem,
  type ProposalViolationCode,
} from "./draft-output";
import { buildFallbackItem, buildFallbackProposal } from "./fallback";
import { createGoogleDraftModel, type GoogleDraftModelOptions } from "./google-model";
import {
  buildModelInput,
  buildRetryPrompt,
  buildSystemInstruction,
  buildUserPrompt,
} from "./prompt";

export type { DraftAgentInput } from "./draft-output";

export interface DraftModelRequest {
  system: string;
  prompt: string;
}

/**
 * Returns `unknown` on purpose: schema validation belongs to this module,
 * so a fake model can exercise both the schema path and the semantic path,
 * and swapping providers never touches the domain.
 */
export interface DraftModel {
  generateProposal(request: DraftModelRequest): Promise<unknown>;
}

export const MAX_MODEL_ATTEMPTS = 2;

export interface DraftGeneration {
  proposal: DraftProposal;
  source: "model" | "fallback";
  /** `0` means the model was never called, which is not a model failure. */
  attempts: number;
  normalizations: readonly ProposalViolationCode[];
}

/**
 * Fills any need the model left out. Composition lives here rather than in
 * the validator because `fallback.ts` imports `draft-output.ts`, so a
 * validator that called the fallback builder would close an import cycle.
 */
function completeProposal(
  proposal: DraftProposal,
  input: DraftAgentInput,
): { proposal: DraftProposal; completed: boolean } {
  const byProductId = new Map(proposal.items.map((item) => [item.productId, item]));
  let completed = false;

  const items: DraftProposalItem[] = input.resolvedNeeds.map((resolved) => {
    const existing = byProductId.get(resolved.selected.productId);
    if (existing !== undefined) {
      return existing;
    }
    completed = true;
    return buildFallbackItem(resolved);
  });

  return { proposal: DraftProposalSchema.parse({ summary: proposal.summary, items }), completed };
}

function fallbackGeneration(input: DraftAgentInput, attempts: number): DraftGeneration {
  return { proposal: buildFallbackProposal(input), source: "fallback", attempts, normalizations: [] };
}

/**
 * One structured Gemini call per attempt, at most two attempts, then the
 * deterministic draft. Never rejects for a model or provider fault: the
 * user gets an explainable draft either way.
 */
export async function generateDraftWithModel(
  model: DraftModel,
  input: DraftAgentInput,
): Promise<DraftGeneration> {
  if (input.resolvedNeeds.length === 0) {
    return fallbackGeneration(input, 0);
  }

  const modelInput = buildModelInput(input);
  const system = buildSystemInstruction();
  let issues: ProposalViolationCode[] = [];

  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 1 ? buildUserPrompt(modelInput) : buildRetryPrompt(modelInput, issues);
    try {
      const raw = await model.generateProposal({ system, prompt });
      const parsed = DraftProposalSchema.safeParse(raw);
      if (!parsed.success) {
        issues = ["schema_invalid"];
        continue;
      }

      const validated = validateProposal(parsed.data, input);
      const { proposal, completed } = completeProposal(validated.proposal, input);
      return {
        proposal,
        source: "model",
        attempts: attempt,
        normalizations: completed
          ? [...validated.normalizations, "missing_need"]
          : validated.normalizations,
      };
    } catch (error) {
      issues = error instanceof InvalidProposalError ? [...error.codes] : ["model_unavailable"];
    }
  }

  return fallbackGeneration(input, MAX_MODEL_ATTEMPTS);
}

/**
 * The production entry point. `apiKey` and `model` come from `getServerEnv`
 * at the call site in Task 13, never from `process.env` here.
 */
export async function generateDraft(
  input: DraftAgentInput,
  options: GoogleDraftModelOptions,
): Promise<DraftGeneration> {
  return generateDraftWithModel(createGoogleDraftModel(options), input);
}

