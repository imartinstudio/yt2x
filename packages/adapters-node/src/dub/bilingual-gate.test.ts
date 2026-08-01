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

  it("blocks when a protected term (grill me / grill with docs) drops out of the Chinese line", async () => {
    const runner = makeRunner(fitMeasurement);
    const result = await evaluateDubBilingualGate({
      bilingualSrt: bilingual("我们来试试这个功能", "Let's Grill Me this feature"),
      zhSrt: zhOnly("我们来试试这个功能"),
      enSrt: enOnly("Let's Grill Me this feature"),
      videoWidth: 1280,
      videoHeight: 720,
      runner,
    });

    expect(result.readyForBurn).toBe(false);
    expect(result.issues.some((i) => i.code === "glossary-violation")).toBe(true);
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
