import path from "node:path";
import {
  NATIVE_LLM_CHAT_TIMEOUT_MS,
  createLlmAdapter,
  patchProcessStatus,
  type LlmProviderId,
} from "@yt2x/adapters-node";
import { isLlmError, type LlmPort, type PipelineStep } from "@yt2x/core";
import { LlmProviderSchema } from "../args/llm.js";
import { resolveLlmConfig, validateLlmConfigReady, defaultCliLlmProvider } from "../config/env.js";

export const NATIVE_EXIT = {
  CONFIG_MISSING: 2,
  NO_INPUT: 3,
  LLM_AUTH: 3,
  LLM_QUOTA: 5,
  LLM_NETWORK: 6,
  PARTIAL_FAILURE: 4,
} as const;

export type NativeLlmCliFlags = {
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
};

export type ResolvedNativeLlm =
  | { ok: true; adapter: LlmPort; provider: LlmProviderId; model: string }
  | { ok: false; exitCode: number; reason: string };

export const exitFromLlmKind = (kind: string): number => {
  if (kind === "AUTH") return NATIVE_EXIT.LLM_AUTH;
  if (kind === "QUOTA") return NATIVE_EXIT.LLM_QUOTA;
  if (kind === "NETWORK") return NATIVE_EXIT.LLM_NETWORK;
  return 1;
};

export const resolveNativeLlm = (flags: NativeLlmCliFlags): ResolvedNativeLlm => {
  const provider = LlmProviderSchema.parse(flags.llmProvider ?? defaultCliLlmProvider());
  const cliConfig: { provider: typeof provider; model?: string; baseUrl?: string } = { provider };
  if (flags.llmModel !== undefined) cliConfig.model = flags.llmModel;
  if (flags.llmBaseUrl !== undefined) cliConfig.baseUrl = flags.llmBaseUrl;

  const resolved = resolveLlmConfig(cliConfig);
  const validity = validateLlmConfigReady(resolved);
  if (!validity.ok) {
    return { ok: false, exitCode: NATIVE_EXIT.CONFIG_MISSING, reason: validity.reason };
  }

  const adapter = createLlmAdapter({
    provider: resolved.provider,
    apiKey: resolved.apiKey!,
    baseUrl: resolved.baseUrl!,
    defaultModel: resolved.model!,
    timeoutMs: NATIVE_LLM_CHAT_TIMEOUT_MS,
  });

  return { ok: true, adapter, provider: resolved.provider, model: resolved.model! };
};

export type BatchVideoDirResolve =
  | { ok: true; targets: string[] }
  | { ok: false; exitCode: number; reason: "empty_pending" | "missing_args" };

export const resolveBatchVideoDirs = async (input: {
  outDir: string;
  all?: boolean;
  videoId?: string[];
  findAllPending: () => Promise<string[]>;
}): Promise<BatchVideoDirResolve> => {
  if (input.all === true) {
    const pending = await input.findAllPending();
    if (pending.length === 0) {
      return { ok: false, exitCode: NATIVE_EXIT.NO_INPUT, reason: "empty_pending" };
    }
    return { ok: true, targets: pending };
  }
  if (input.videoId !== undefined && input.videoId.length > 0) {
    const targets = input.videoId.map((id) => (path.isAbsolute(id) ? id : path.join(input.outDir, id)));
    return { ok: true, targets };
  }
  return { ok: false, exitCode: NATIVE_EXIT.NO_INPUT, reason: "missing_args" };
};

export const resolveArticleOutRoot = (flags: { articleOutDir?: string }, defaultDir: string): string =>
  path.resolve(flags.articleOutDir ?? defaultDir);

export const patchLlmStepFailed = async (
  videoDir: string,
  step: PipelineStep,
  err: unknown,
): Promise<void> => {
  const message = err instanceof Error ? err.message : String(err);
  const videoId = path.basename(videoDir);
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const code = isLlmError(err) ? `E_LLM_${err.kind}` : "E_UNKNOWN";
  await patchProcessStatus(videoDir, { videoId, url }, {
    step,
    stepInfo: {
      status: "failed",
      finishedAt: new Date().toISOString(),
      artifacts: [],
      error: { code, message },
    },
  });
};
