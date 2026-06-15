import { classifyHttpError, classifyNetworkError } from "./errors.js";
import { postJson, safeJson, type Fetcher } from "./http.js";
import type { LlmError } from "@yt2x/core";

// ── port ──

export type ImageSize =
  | "1024x1024" // 1:1 square – WeChat cover, Xiaohongshu
  | "1792x1024" // 16:9 landscape – WeChat wide cover
  | "1024x1792"; // 9:16 portrait – Xiaohongshu

export type ImageGenerateRequest = {
  prompt: string;
  size?: ImageSize;
  style?: "vivid" | "natural";
  model?: string;
};

export type ImageGenerateResponse = {
  url: string;
  revisedPrompt?: string;
  width: number;
  height: number;
};

export interface ImageGeneratorPort {
  generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResponse>;
}

// ── OpenAI DALL-E compatible adapter ──

export type ImageGeneratorConfig = {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
};

type DalleResponse = {
  created?: number;
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  error?: { code?: string; message?: string; type?: string };
};

const parseSize = (size: ImageSize): { width: number; height: number } => {
  const [w, h] = size.split("x").map(Number) as [number, number];
  return { width: w!, height: h! };
};

export const createImageGenerator = (config: ImageGeneratorConfig): ImageGeneratorPort => {
  if (config.apiKey.length === 0) {
    throw new Error("createImageGenerator: empty apiKey");
  }
  if (config.baseUrl.length === 0) {
    throw new Error("createImageGenerator: empty baseUrl");
  }

  const model = config.defaultModel ?? "dall-e-3";
  // strip trailing /v1 to avoid doubling (baseUrl may already include /v1)
  const base = config.baseUrl.replace(/\/v1\/?$/, "");
  const endpoint = `${base}/v1/images/generations`;

  return {
    async generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResponse> {
      const size = req.size ?? "1024x1024";
      const body = {
        model: req.model ?? model,
        prompt: req.prompt,
        n: 1,
        size,
        ...(req.style !== undefined ? { style: req.style } : {}),
      };

      let resp: Response;
      try {
        resp = await postJson({
          url: endpoint,
          headers: { authorization: `Bearer ${config.apiKey}` },
          body,
          ...(config.fetcher !== undefined ? { fetcher: config.fetcher } : {}),
          ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
          provider: "openai",
          model: req.model ?? model,
        });
      } catch (err: unknown) {
        throw classifyNetworkError({
          provider: "openai",
          model: req.model ?? model,
          cause: err,
        }) satisfies LlmError;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw classifyHttpError({
          provider: "openai",
          model: req.model ?? model,
          status: resp.status,
          message: text,
        }) satisfies LlmError;
      }

      const json = (await safeJson(resp)) as DalleResponse;

      if (json.error !== undefined) {
        throw classifyHttpError({
          provider: "openai",
          model: req.model ?? model,
          status: resp.status,
          message: json.error.message ?? JSON.stringify(json.error),
        }) satisfies LlmError;
      }

      const data = json.data?.[0];
      // support both url (OpenAI) and b64_json (n1n proxy and some providers)
      let imageUrl = data?.url;
      if ((imageUrl === undefined || imageUrl.length === 0) && data?.b64_json !== undefined && data.b64_json.length > 0) {
        const ext = req.size === "1024x1024" ? "png" : "png";
        imageUrl = `data:image/${ext};base64,${data.b64_json}`;
      }
      if (imageUrl === undefined || imageUrl.length === 0) {
        throw classifyHttpError({
          provider: "openai",
          model: req.model ?? model,
          status: resp.status,
          message: "No image URL or b64_json in DALL-E response",
        }) satisfies LlmError;
      }

      const dimensions = parseSize(size);
      return {
        url: imageUrl,
        ...(data?.revised_prompt !== undefined ? { revisedPrompt: data.revised_prompt } : {}),
        ...dimensions,
      };
    },
  };
};
