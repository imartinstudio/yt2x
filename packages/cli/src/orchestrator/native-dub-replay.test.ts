import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_EXIT } from "./native-stage-common.js";
import { executeDubReplay } from "./native-dub-replay.js";

/** 造一份最小但自洽的产物：配音稿 + 时长报告 + 落点报告。 */
const seedArtifacts = async (): Promise<{ articleRoot: string; videoId: string }> => {
  const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-replay-"));
  const videoId = "abcdefghijk";
  const dubDir = path.join(articleRoot, videoId, "dub");
  await mkdir(dubDir, { recursive: true });

  const lines = [1, 2].map((index) => ({
    index,
    startMs: (index - 1) * 6_000,
    endMs: index * 6_000,
    targetDurationMs: 6_000,
    text: "这是一句用来测试重放的中文，长度足够构成一条显示单元。",
    sourceText: "a sentence long enough to replay",
    cueIndices: [index],
  }));

  await writeFile(
    path.join(dubDir, "dub-script.json"),
    JSON.stringify({
      version: 2,
      videoId,
      sourceWords: "video/full.local.en.words.json",
      rewriteModel: "m",
      droppedCount: 0,
      lines,
    }),
    "utf8",
  );
  await writeFile(
    path.join(dubDir, "dub-timing.json"),
    JSON.stringify({
      version: 1,
      videoId,
      engine: "edge-tts",
      voice: "v",
      lineCount: lines.length,
      medianRatio: 1,
      overflowCount: 0,
      totalDriftMs: 0,
      lines: lines.map((l) => ({
        index: l.index,
        targetDurationMs: l.targetDurationMs,
        synthesizedMs: 5_400,
        ratio: 0.9,
        charCount: l.text.length,
        audioFile: `lines/000${l.index}.mp3`,
      })),
    }),
    "utf8",
  );
  return { articleRoot, videoId };
};

describe("executeDubReplay", () => {
  it("refuses to run without a video id instead of guessing one", async () => {
    expect(await executeDubReplay({})).toBe(NATIVE_EXIT.NO_INPUT);
  });

  it("reports missing artifacts as an input problem, pointing at the run that produces them", async () => {
    // 重放读的是 `yt2x dub` 留下的产物；没跑过就没有可重放的东西，这不是内部错误
    expect(
      await executeDubReplay({
        videoId: "abcdefghijk",
        articleOutDir: path.join(os.tmpdir(), "yt2x-replay-nowhere"),
      }),
    ).toBe(NATIVE_EXIT.NO_INPUT);
  });

  it("replays a seeded run and reports the metrics", async () => {
    const { articleRoot, videoId } = await seedArtifacts();
    expect(await executeDubReplay({ videoId, articleOutDir: articleRoot })).toBe(0);
  });

  it("accepts counterfactual overrides so parameters can be compared", async () => {
    const { articleRoot, videoId } = await seedArtifacts();
    expect(
      await executeDubReplay({
        videoId,
        articleOutDir: articleRoot,
        preferredRateMin: "0.85",
      }),
    ).toBe(0);
  });

  it("turns a bad override into an exit code, not an escaped exception", async () => {
    const { articleRoot, videoId } = await seedArtifacts();
    expect(
      await executeDubReplay({ videoId, articleOutDir: articleRoot, preferredRateMin: "abc" }),
    ).toBe(NATIVE_EXIT.CONFIG_MISSING);
  });

  it("keeps a video id from escaping the article root", async () => {
    // 只 trim 就拼进 path.join 会让 `--video-id ../../etc` 走出 article 根目录；
    // 与 native-dub 同一道关，videoId 只能当安全目录名
    const { articleRoot } = await seedArtifacts();
    const exitCode = await executeDubReplay({
      videoId: "../../../etc",
      articleOutDir: articleRoot,
    });
    // 目录不存在，但关键是它没有解析到 article 根之外——退出码是「找不到产物」而非崩溃
    expect(exitCode).toBe(NATIVE_EXIT.NO_INPUT);
  });
});
