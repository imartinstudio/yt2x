import { describe, expect, it } from "vitest";
import {
  extractJsonStringField,
  parseJsonWithRepairs,
  stripJsonFenceWrapper,
} from "../llm/parse-json.js";
import { parseGeneratedVideoShortPostJson } from "./generator.js";

describe("parseGeneratedVideoShortPostJson", () => {
  it("accepts json fence wrappers", () => {
    const payload = JSON.stringify({ text: "第一段\n\n第二段\n\n完整视频+中文字幕：👇" });
    expect(parseGeneratedVideoShortPostJson("```json\n" + payload + "\n```").text).toContain("完整视频");
  });

  it("salvages text when the model emits unescaped quotes inside the string", () => {
    const raw = '{"text": "他说 "Claude Cowork" 很有用\n\n完整视频+中文字幕：👇"}';
    expect(parseGeneratedVideoShortPostJson(raw).text).toContain("Claude Cowork");
  });

  it("salvages text when json is truncated before the closing quote", () => {
    const raw = '{"text": "钩子段落\\n\\n观点段落\\n\\n总结段';
    expect(parseGeneratedVideoShortPostJson(raw).text).toContain("钩子段落");
  });
});

describe("parseJsonWithRepairs", () => {
  it("removes trailing commas before closing braces", () => {
    expect(parseJsonWithRepairs('{"text":"ok",}')).toEqual({ text: "ok" });
  });

  it("extracts the outer object when extra prose surrounds json", () => {
    const parsed = parseJsonWithRepairs('Here is JSON:\n{"text":"ok"}\nThanks.');
    expect(parsed).toEqual({ text: "ok" });
  });
});

describe("extractJsonStringField", () => {
  it("reads escaped newlines from a broken payload", () => {
    const raw = String.raw`{"text": "第一行\n\n第二行"}`;
    expect(extractJsonStringField(raw, "text")).toBe("第一行\n\n第二行");
  });

  it("returns null when the field is missing", () => {
    expect(extractJsonStringField(stripJsonFenceWrapper('{"title":"x"}'), "text")).toBeNull();
  });
});
