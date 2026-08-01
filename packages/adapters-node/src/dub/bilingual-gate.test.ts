import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../process/index.js";
import { evaluateDubBilingualGate } from "./bilingual-gate.js";

vi.mock("../acquire/resolve-python.js", () => ({
  resolvePythonWithPillow: vi.fn().mockResolvedValue("python3"),
}));

/** A single aligned bilingual cue, split into zh/en single-language variants for the test. */
const bilingual = (zh: string, en: string): string =>
  `1\n00:00:01,000 --> 00:00:04,000\n${zh}\n${en}\n`;
const zhOnly = (zh: string): string => `1\n00:00:01,000 --> 00:00:04,000\n${zh}\n`;
const enOnly = (en: string): string => `1\n00:00:01,000 --> 00:00:04,000\n${en}\n`;

const makeRunner = (measurements: unknown[]): ProcessRunner => ({
  run: vi.fn().mockImplementation(async (spec) => {
    const outputIndex = spec.args?.indexOf("--output") ?? -1;
    if (outputIndex >= 0) {
      const outputPath = spec.args?.[outputIndex + 1];
      await writeFile(outputPath!, JSON.stringify(measurements));
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
});

const fitMeasurement = [
  {
    cueIndex: 1,
    zhWidth: 100,
    fitWidth: 1000,
    lineCount: 1,
    severity: "fit",
    resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
  },
];

describe("evaluateDubBilingualGate", () => {
  it("passes clean, well-aligned bilingual/zh/en content", async () => {
    const runner = makeRunner(fitMeasurement);
    const result = await evaluateDubBilingualGate({
      bilingualSrt: bilingual("你好世界", "Hello world"),
      zhSrt: zhOnly("你好世界"),
      enSrt: enOnly("Hello world"),
      videoWidth: 1280,
      videoHeight: 720,
      runner,
    });

    expect(result.readyForBurn).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports a dropped protected term but does not block on it", async () => {
    // 配音链路把 glossary-violation 降为 advisory——检查分辨不出「专名丢了、意思也丢了」
    // 和「专名丢了、意思用意译保住了」，而且可以通过让输出变糟来满足：逼模型补回专名时，
    // 它会把已有的派生词译法改写成专名（真实素材上「追问环节」→「Grill Me 环节」），
    // 检查放行而译文更错。理由见 bilingual-gate.ts 的实现注释。
    const runner = makeRunner(fitMeasurement);
    const result = await evaluateDubBilingualGate({
      bilingualSrt: bilingual("我们来试试这个功能", "Let's Grill Me this feature"),
      zhSrt: zhOnly("我们来试试这个功能"),
      enSrt: enOnly("Let's Grill Me this feature"),
      videoWidth: 1280,
      videoHeight: 720,
      runner,
    });

    expect(result.issues.some((i) => i.code === "glossary-violation")).toBe(true);
    expect(result.readyForBurn).toBe(true);
  });

  it("does not block when a protected term lands in a different cue of the same utterance (utteranceBoundariesMs grouping)", async () => {
    const runner = makeRunner(fitMeasurement);
    // 一个话语单元被细分成两条显示单元，"PRD" 落在英文第一条、中文第二条——中英文
    // 显示单元切分边界不同，是真实全片跑出来的假阳性形状。
    const bilingualSrt = [
      "1\n00:00:01,000 --> 00:00:02,000\n安全交付给团队的\nShip the PRD\n",
      "2\n00:00:02,000 --> 00:00:04,000\nPRD。\nto the team.\n",
    ].join("\n");
    const zhSrt = [
      "1\n00:00:01,000 --> 00:00:02,000\n安全交付给团队的\n",
      "2\n00:00:02,000 --> 00:00:04,000\nPRD。\n",
    ].join("\n");
    const enSrt = [
      "1\n00:00:01,000 --> 00:00:02,000\nShip the PRD\n",
      "2\n00:00:02,000 --> 00:00:04,000\nto the team.\n",
    ].join("\n");

    const result = await evaluateDubBilingualGate({
      bilingualSrt,
      zhSrt,
      enSrt,
      videoWidth: 1280,
      videoHeight: 720,
      runner,
      utteranceBoundariesMs: [4000],
    });

    expect(result.issues.some((i) => i.code === "glossary-violation")).toBe(false);
    expect(result.readyForBurn).toBe(true);
  });

  it("blocks when the three SRTs are not aligned cue-by-cue (timing mismatch)", async () => {
    const runner = makeRunner(fitMeasurement);
    const result = await evaluateDubBilingualGate({
      bilingualSrt: bilingual("你好", "Hello"),
      zhSrt: zhOnly("你好"),
      enSrt: "1\n00:00:02,000 --> 00:00:05,000\nHello\n",
      videoWidth: 1280,
      videoHeight: 720,
      runner,
    });

    expect(result.readyForBurn).toBe(false);
    expect(result.issues.some((i) => i.code === "bilingual-timing")).toBe(true);
  });

  it("blocks on a hard layout measurement (line too wide/tall to fit the frame)", async () => {
    const runner = makeRunner([
      { cueIndex: 1, zhWidth: 900, fitWidth: 1000, lineCount: 1, severity: "hard", resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" } },
    ]);
    const result = await evaluateDubBilingualGate({
      bilingualSrt: bilingual("你好世界", "Hello world"),
      zhSrt: zhOnly("你好世界"),
      enSrt: enOnly("Hello world"),
      videoWidth: 1280,
      videoHeight: 720,
      runner,
    });

    expect(result.readyForBurn).toBe(false);
    expect(result.issues.some((i) => i.code === "hard-layout")).toBe(true);
  });
});
