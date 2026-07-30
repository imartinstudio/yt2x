import {
  TtsError,
  clampRate,
  type TtsErrorContext,
  type TtsPort,
  type TtsRateRange,
  type TtsRequest,
  type TtsResult,
} from "@yt2x/core";

/**
 * ElevenLabs TTS 适配器（成片引擎）。
 *
 * API：POST /v1/text-to-speech/{voice_id}
 * Header：xi-api-key
 * Body：text + model_id + voice_settings.speed
 *
 * speed 区间按官方 TTS / Playground 文档取 0.7–1.2（不是 Agents 专属文档里的
 * 同名参数，也不是部分 SDK 注释里写的 0.25–4.0）。协商层读 rateRange，
 * 不会向引擎要它做不到的加速。
 */

export const ELEVENLABS_ENGINE_ID = "elevenlabs";

/** 官方 TTS speed 可用区间（见 ElevenLabs Create speech / voice_settings.speed）。 */
export const ELEVENLABS_RATE_RANGE: TtsRateRange = { min: 0.7, max: 1.2 };

export const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";
export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

/** 环境变量：API key。 */
export const ELEVENLABS_API_KEY_ENV = ["ELEVENLABS_API_KEY", "XI_API_KEY"] as const;
/** 环境变量：默认音色 ID（可被 --voice 覆盖）。 */
export const ELEVENLABS_VOICE_ENV = ["ELEVENLABS_VOICE_ID"] as const;

const DEFAULT_TIMEOUT_MS = 120_000;

export type ElevenLabsAdapterOptions = {
  apiKey: string;
  /** 覆盖默认 base URL（代理 / 区域端点）。 */
  baseUrl?: string;
  modelId?: string;
  timeoutMs?: number;
  /** 可注入的 fetch，单测用。 */
  fetchImpl?: typeof fetch;
};

export const readElevenLabsApiKeyFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  for (const key of ELEVENLABS_API_KEY_ENV) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

export const readElevenLabsVoiceFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  for (const key of ELEVENLABS_VOICE_ENV) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

const errorContext = (
  voice?: string,
  retriable = false,
  httpStatus?: number,
): TtsErrorContext => ({
  engine: ELEVENLABS_ENGINE_ID,
  ...(voice !== undefined ? { voice } : {}),
  ...(httpStatus !== undefined ? { httpStatus } : {}),
  retriable,
});

const classifyHttpError = async (
  response: Response,
  voice: string,
): Promise<TtsError> => {
  const status = response.status;
  let body = "";
  try {
    body = (await response.text()).slice(0, 400);
  } catch {
    /* ignore */
  }
  const detail = body.length > 0 ? ` ${body}` : "";

  if (status === 401 || status === 403) {
    return new TtsError(
      "AUTH",
      `ElevenLabs authentication failed (HTTP ${status}).${detail}`,
      errorContext(voice, false, status),
    );
  }
  if (status === 429) {
    return new TtsError(
      "RATE_LIMIT",
      `ElevenLabs rate limited (HTTP 429).${detail}`,
      errorContext(voice, true, status),
    );
  }
  if (status === 402 || /quota|credit|payment/iu.test(body)) {
    return new TtsError(
      "QUOTA",
      `ElevenLabs quota exceeded (HTTP ${status}).${detail}`,
      errorContext(voice, false, status),
    );
  }
  if (status >= 400 && status < 500) {
    return new TtsError(
      "BAD_REQUEST",
      `ElevenLabs rejected the request (HTTP ${status}).${detail}`,
      errorContext(voice, false, status),
    );
  }
  if (status >= 500) {
    return new TtsError(
      "NETWORK",
      `ElevenLabs server error (HTTP ${status}).${detail}`,
      errorContext(voice, true, status),
    );
  }
  return new TtsError(
    "UNKNOWN",
    `ElevenLabs unexpected HTTP ${status}.${detail}`,
    errorContext(voice, false, status),
  );
};

export const createElevenLabsAdapter = (options: ElevenLabsAdapterOptions): TtsPort => {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new TtsError(
      "UNAVAILABLE",
      `ElevenLabs API key is empty. Set one of: ${ELEVENLABS_API_KEY_ENV.join(", ")}.`,
      errorContext(),
    );
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL).replace(/\/+$/u, "");
  const modelId = options.modelId ?? DEFAULT_ELEVENLABS_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const synthesize = async (req: TtsRequest): Promise<TtsResult> => {
    const text = req.text.trim();
    if (text.length === 0) {
      throw new TtsError("BAD_REQUEST", "TTS text is empty.", errorContext(req.voice));
    }
    if (req.voice.trim().length === 0) {
      throw new TtsError(
        "BAD_REQUEST",
        "TTS voice is empty. Pass --voice or set ELEVENLABS_VOICE_ID.",
        errorContext(),
      );
    }

    const format = req.format ?? "mp3";
    if (format !== "mp3") {
      throw new TtsError(
        "BAD_REQUEST",
        `ElevenLabs adapter currently returns mp3 only; "${format}" was requested.`,
        errorContext(req.voice),
      );
    }

    const rate = clampRate(req.rate, ELEVENLABS_RATE_RANGE);
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=mp3_44100_128`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: {
              speed: rate,
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new TtsError(
            "NETWORK",
            "ElevenLabs request timed out or was aborted.",
            errorContext(req.voice, true),
            { cause: err },
          );
        }
        throw new TtsError(
          "NETWORK",
          `ElevenLabs network error: ${err instanceof Error ? err.message : String(err)}`,
          errorContext(req.voice, true),
          { cause: err },
        );
      }

      if (!response.ok) {
        throw await classifyHttpError(response, req.voice);
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength === 0) {
        throw new TtsError(
          "BAD_RESPONSE",
          "ElevenLabs returned an empty audio body.",
          errorContext(req.voice, false, response.status),
        );
      }

      return { audio: buffer, format: "mp3", voice: req.voice, rate };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  };

  return { id: ELEVENLABS_ENGINE_ID, rateRange: ELEVENLABS_RATE_RANGE, synthesize };
};
