import { describe, expect, it, vi } from "vitest";
import { isTtsError } from "@yt2x/core";
import {
  ELEVENLABS_RATE_RANGE,
  createElevenLabsAdapter,
  readElevenLabsApiKeyFromEnv,
  readElevenLabsVoiceFromEnv,
} from "./elevenlabs.js";

describe("readElevenLabsApiKeyFromEnv", () => {
  it("reads ELEVENLABS_API_KEY first", () => {
    expect(
      readElevenLabsApiKeyFromEnv({ ELEVENLABS_API_KEY: "primary", XI_API_KEY: "fallback" }),
    ).toBe("primary");
  });

  it("falls back to XI_API_KEY", () => {
    expect(readElevenLabsApiKeyFromEnv({ XI_API_KEY: "xi" })).toBe("xi");
  });
});

describe("readElevenLabsVoiceFromEnv", () => {
  it("reads ELEVENLABS_VOICE_ID", () => {
    expect(readElevenLabsVoiceFromEnv({ ELEVENLABS_VOICE_ID: "voice-1" })).toBe("voice-1");
  });
});

describe("createElevenLabsAdapter", () => {
  it("posts text with clamped speed and returns mp3 bytes", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    });
    const tts = createElevenLabsAdapter({ apiKey: "key", fetchImpl });
    expect(tts.id).toBe("elevenlabs");
    expect(tts.rateRange).toEqual(ELEVENLABS_RATE_RANGE);

    const result = await tts.synthesize({
      text: "你好",
      voice: "voice-1",
      rate: 1.5, // above max → clamped to 1.2
    });

    expect(result.rate).toBe(1.2);
    expect(result.audio.byteLength).toBe(4);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "xi-api-key": "key" });
    const body = JSON.parse(String((init as RequestInit).body)) as {
      voice_settings: { speed: number };
      model_id: string;
    };
    expect(body.voice_settings.speed).toBe(1.2);
    expect(body.model_id).toBe("eleven_multilingual_v2");
  });

  it("maps 401 to AUTH", async () => {
    const tts = createElevenLabsAdapter({
      apiKey: "key",
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    await expect(tts.synthesize({ text: "hi", voice: "v" })).rejects.toSatisfy(
      (err: unknown) => isTtsError(err) && err.kind === "AUTH",
    );
  });

  it("maps 429 to RATE_LIMIT", async () => {
    const tts = createElevenLabsAdapter({
      apiKey: "key",
      fetchImpl: async () => new Response("slow down", { status: 429 }),
    });
    await expect(tts.synthesize({ text: "hi", voice: "v" })).rejects.toSatisfy(
      (err: unknown) => isTtsError(err) && err.kind === "RATE_LIMIT" && err.context.retriable,
    );
  });

  it("rejects empty text", async () => {
    const tts = createElevenLabsAdapter({
      apiKey: "key",
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await expect(tts.synthesize({ text: "  ", voice: "v" })).rejects.toSatisfy(
      (err: unknown) => isTtsError(err) && err.kind === "BAD_REQUEST",
    );
  });

  it("rejects empty api key at construction", () => {
    expect(() => createElevenLabsAdapter({ apiKey: "  " })).toThrow(/API key is empty/i);
  });
});
