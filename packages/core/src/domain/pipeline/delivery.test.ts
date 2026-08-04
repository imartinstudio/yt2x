import { describe, expect, it } from "vitest";
import {
  assertFromCompatibleWithDeliver,
  type DeliverMode,
  DeliverModeSchema,
  DeliveryConflictError,
  FromModeSchema,
  internalSubtitleParamsFor,
  resolveFrom,
} from "./delivery.js";

describe("assertFromCompatibleWithDeliver", () => {
  it("accepts dubbed + local-words", () => {
    expect(() => assertFromCompatibleWithDeliver("dubbed", "local-words")).not.toThrow();
  });

  it("rejects dubbed + youtube with a DeliveryConflictError explaining why", () => {
    expect(() => assertFromCompatibleWithDeliver("dubbed", "youtube")).toThrow(
      DeliveryConflictError,
    );
    expect(() => assertFromCompatibleWithDeliver("dubbed", "youtube")).toThrow(/词级时间戳/);
  });

  it("rejects dubbed + local (sentence-level has no word timestamps either)", () => {
    expect(() => assertFromCompatibleWithDeliver("dubbed", "local")).toThrow(
      DeliveryConflictError,
    );
  });

  it("rejects dubbed + transcribe", () => {
    expect(() => assertFromCompatibleWithDeliver("dubbed", "transcribe")).toThrow(
      DeliveryConflictError,
    );
  });

  it("rejects dubbed + file", () => {
    expect(() => assertFromCompatibleWithDeliver("dubbed", "file")).toThrow(
      DeliveryConflictError,
    );
  });

  it("rejects a non-dubbed deliver mode paired with --from local-words", () => {
    expect(() => assertFromCompatibleWithDeliver("bilingual-burned", "local-words")).toThrow(
      DeliveryConflictError,
    );
  });

  it("accepts any non-dubbed deliver mode with youtube/transcribe/local/file", () => {
    const deliverModes = ["none", "zh-srt", "zh-burned", "bilingual-srt", "bilingual-burned"] as const;
    const fromModes = ["youtube", "transcribe", "local", "file"] as const;
    for (const deliver of deliverModes) {
      for (const from of fromModes) {
        expect(() => assertFromCompatibleWithDeliver(deliver, from)).not.toThrow();
      }
    }
  });
});

describe("resolveFrom", () => {
  it("defaults to local-words when --deliver dubbed is chosen without --from", () => {
    expect(resolveFrom("dubbed", undefined)).toBe("local-words");
  });

  it("defaults to auto for every non-dubbed deliver mode without --from", () => {
    const deliverModes = ["none", "zh-srt", "zh-burned", "bilingual-srt", "bilingual-burned"] as const;
    for (const deliver of deliverModes) {
      expect(resolveFrom(deliver, undefined)).toBe("auto");
    }
  });

  it("returns the explicit --from value when compatible", () => {
    expect(resolveFrom("bilingual-burned", "youtube")).toBe("youtube");
    expect(resolveFrom("dubbed", "local-words")).toBe("local-words");
  });

  it("throws the same DeliveryConflictError as assertFromCompatibleWithDeliver for an explicit contradiction", () => {
    expect(() => resolveFrom("dubbed", "youtube")).toThrow(DeliveryConflictError);
  });
});

describe("DeliverModeSchema / FromModeSchema", () => {
  it("accepts exactly the six documented delivery tiers", () => {
    const valid = ["none", "zh-srt", "zh-burned", "bilingual-srt", "bilingual-burned", "dubbed"];
    for (const v of valid) expect(DeliverModeSchema.parse(v)).toBe(v);
    expect(() => DeliverModeSchema.parse("burned")).toThrow();
  });

  it("accepts exactly the five documented subtitle channels", () => {
    const valid = ["youtube", "transcribe", "local", "local-words", "file"];
    for (const v of valid) expect(FromModeSchema.parse(v)).toBe(v);
    expect(() => FromModeSchema.parse("auto")).toThrow();
  });
});

describe("internalSubtitleParamsFor", () => {
  it("maps none to no subtitle work and no dub", () => {
    expect(internalSubtitleParamsFor("none")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "off",
      needsDub: false,
    });
  });

  it("maps zh-srt to a plain zh srt, no burn, no bilingual", () => {
    expect(internalSubtitleParamsFor("zh-srt")).toEqual({
      subtitleZh: "srt",
      subtitleBilingual: "off",
      needsDub: false,
    });
  });

  it("maps zh-burned to a zh-only burn, no bilingual", () => {
    expect(internalSubtitleParamsFor("zh-burned")).toEqual({
      subtitleZh: "burned",
      subtitleBilingual: "off",
      needsDub: false,
    });
  });

  it("maps bilingual-srt to bilingual srt with subtitleZh off (avoids the zh-only burn side effect)", () => {
    expect(internalSubtitleParamsFor("bilingual-srt")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "srt",
      needsDub: false,
    });
  });

  it("maps bilingual-burned to bilingual burn with subtitleZh off", () => {
    expect(internalSubtitleParamsFor("bilingual-burned")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "burned",
      needsDub: false,
    });
  });

  it("maps dubbed to no acquire-side subtitle work at all, needsDub true", () => {
    expect(internalSubtitleParamsFor("dubbed")).toEqual({
      subtitleZh: "off",
      subtitleBilingual: "off",
      needsDub: true,
    });
  });

  it("covers all six DeliverMode values exhaustively (compile-time + runtime cross-check)", () => {
    const allModes: DeliverMode[] = ["none", "zh-srt", "zh-burned", "bilingual-srt", "bilingual-burned", "dubbed"];
    for (const mode of allModes) {
      expect(() => internalSubtitleParamsFor(mode)).not.toThrow();
    }
  });
});
