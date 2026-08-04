import { beforeEach, describe, expect, it, vi } from "vitest";

const executeNativeNotesMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-notes.js", () => ({ executeNativeNotes: executeNativeNotesMock }));

const executeNativeArticleMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./native-article.js", () => ({ executeNativeArticle: executeNativeArticleMock }));

import { executeNativeText } from "./native-text.js";

beforeEach(() => {
  executeNativeNotesMock.mockClear();
  executeNativeArticleMock.mockClear();
});

describe("executeNativeText", () => {
  it("requires --video-id", async () => {
    const code = await executeNativeText({});
    expect(code).not.toBe(0);
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
  });

  it("runs notes then article for each video id, in order", async () => {
    const code = await executeNativeText({ videoId: ["vidA", "vidB"], llmProvider: "openai" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledTimes(2);
    expect(executeNativeArticleMock).toHaveBeenCalledTimes(2);
    expect(executeNativeNotesMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeNativeArticleMock.mock.invocationCallOrder[0]!,
    );
  });

  it("skips article when --article skip is passed", async () => {
    const code = await executeNativeText({ videoId: ["vidA"], article: "skip", llmProvider: "openai" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).toHaveBeenCalledOnce();
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
  });

  it("skips notes when --notes skip is passed", async () => {
    const code = await executeNativeText({ videoId: ["vidA"], notes: "skip", llmProvider: "openai" });
    expect(code).toBe(0);
    expect(executeNativeNotesMock).not.toHaveBeenCalled();
    expect(executeNativeArticleMock).toHaveBeenCalledOnce();
  });

  it("stops at the first non-zero exit code and does not run article", async () => {
    executeNativeNotesMock.mockResolvedValueOnce(3);
    const code = await executeNativeText({ videoId: ["vidA"], llmProvider: "openai" });
    expect(code).toBe(3);
    expect(executeNativeArticleMock).not.toHaveBeenCalled();
  });

  it("passes --platform-targets through to the article stage", async () => {
    await executeNativeText({
      videoId: ["vidA"],
      llmProvider: "openai",
      platformTargets: "xiaohongshu,wechat",
    });
    expect(executeNativeArticleMock.mock.calls[0]![0]).toMatchObject({
      platformTargets: "xiaohongshu,wechat",
    });
  });
});
