import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Output, generateText } from "ai";

import type { DraftModel, DraftModelRequest } from "./draft-agent";
import { DraftProposalSchema } from "./draft-output";

/** Agent architecture section 11 requires a bounded generation run. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 30_000;

export interface GoogleDraftModelOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injected by the contract test; production leaves it undefined. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The only file in the repository that imports the AI SDK. It builds one
 * call and returns what came back; validation, retries and fallback all
 * belong to `draft-agent.ts`, which is why that module needs no SDK mock.
 *
 * The provider is constructed explicitly rather than through the ambient
 * `google` singleton so the key is passed in, never read from the
 * environment inside `src/features/agent/`.
 */
export function createGoogleDraftModel(options: GoogleDraftModelOptions): DraftModel {
  const provider = createGoogleGenerativeAI({ apiKey: options.apiKey, fetch: options.fetch });
  const timeoutMs = options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

  return {
    async generateProposal(request: DraftModelRequest): Promise<unknown> {
      const result = await generateText({
        model: provider(options.model),
        system: request.system,
        prompt: request.prompt,
        output: Output.object({ schema: DraftProposalSchema }),
        temperature: 0,
        // The two-attempt policy belongs to `generateDraftWithModel`.
        // Leaving the SDK's own retry on would silently multiply it.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
        providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
      });
      return result.output;
    },
  };
}
