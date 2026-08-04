# Video Delivery Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 ADR-0006 的地基部分——统一 demucs/TTS 默认值探测，并在 `packages/core` 新增
`--deliver`/`--from` 互斥枚举的校验与解析逻辑——不改动任何现有 CLI 命令的对外行为。

**Architecture:** 四个独立、可单独合并的任务：两个是 `resolve-python.ts` 家族里补一个能力探测
函数（跟 `resolvePythonWithFasterWhisper` 完全同构）并在 `dub`/`pipeline --dub` 两处调用点接上；
一个是把 `pipeline --dub-engine` 的默认值从 `elevenlabs` 改成 `edge-tts`，跟独立 `dub` 命令的默认
保持一致；最后一个是全新的纯函数模块 `packages/core/src/domain/pipeline/delivery.ts`，把 ADR-0006
「`--deliver` 六档 × `--from` 五通道」的校验/解析规则写成可独立单测的代码，暂不接入任何命令行
参数解析或 orchestrator 调用——这一半属于 Plan 2（ADR-0005 的命令树切分：新建 `yt2x video`/
`yt2x text`，删除 `pipeline`/`acquire`/`subtitle`），需要先完整读完
`native-pipeline.ts`/`execute-native-acquire.ts` 的调用时序才能不留占位符地写出来，本计划不包含。

## Global Constraints

- TDD：每个任务先写失败测试，再写最小实现（见 `CONTRIBUTING.md`「测试要求」）。
- 默认不写注释；只在 WHY 不明显时写一行（隐藏约束、非显而易见的行为），不写 WHAT。
- 不做向后兼容 shim、不加 feature flag——这四个任务都是纯新增或直接替换默认值，没有旧路径需要保留。
- 遵守 `CONTRIBUTING.md`「命名规范」：新增的标识符要跟 CONTEXT.md/ADR 里用的词一致
  （`deliver`/`from`/`local-words` 等）。
- 遵守 `CONTRIBUTING.md`「CLI 参数归属」的硬约束：不新增 `--*-path` 类环境探测参数——本计划里
  demucs 的自动探测是去补齐能力探测，不是新增参数。
- 每个任务跑 `npx vitest run <改动到的测试文件>`，全部任务完成后跑一次
  `npx tsc -b && npx eslint <改动文件> && npx vitest run` 确认无回归。

---

### Task 1: `resolvePythonWithDemucs` 能力探测

**Files:**

- Modify: `packages/adapters-node/src/acquire/resolve-python.ts`
- Modify: `packages/adapters-node/src/acquire/resolve-python.test.ts`
- Modify: `packages/adapters-node/src/acquire/index.ts`（新增一行导出）

**Interfaces:**

- Produces: `resolvePythonWithDemucs(): Promise<string | undefined>`——跟同文件里已有的
  `resolvePythonWithFasterWhisper`/`resolvePythonWithTorchaudio` 签名完全一致，探测不到时返回
  `undefined` 而不是抛错。`resetResolvedDemucsPythonCache(): void` 供测试重置缓存。
  这两个名字是 Task 2 唯一需要从 `@yt2x/adapters-node` 导入的东西。

- [ ] **Step 1: 在 `resolve-python.test.ts` 顶部的 import 里加上新符号，并写失败测试**

把文件顶部的 import 改成：

```ts
import { describe, expect, it } from "vitest";
import {
  hasDemucs,
  hasFasterWhisper,
  hasTorchaudio,
  resetResolvedDemucsPythonCache,
  resetResolvedFasterWhisperPythonCache,
  resetResolvedTorchaudioPythonCache,
  resolvePythonWithDemucs,
  resolvePythonWithFasterWhisper,
  resolvePythonWithTorchaudio,
} from "./resolve-python.js";
```

在文件末尾（`resolvePythonWithFasterWhisper` 的 `describe` 块之后）追加：

```ts
describe("hasDemucs", () => {
  it("returns false for an interpreter that lacks demucs", async () => {
    await expect(hasDemucs("/usr/bin/python3")).resolves.toBe(false);
  });

  it("returns false for a nonexistent binary instead of throwing", async () => {
    await expect(hasDemucs("/no/such/python3")).resolves.toBe(false);
  });
});

describe("resolvePythonWithDemucs", () => {
  it("resolves without throwing, returning either a python path or undefined", async () => {
    resetResolvedDemucsPythonCache();
    const result = await resolvePythonWithDemucs();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("caches the result across calls", async () => {
    resetResolvedDemucsPythonCache();
    const first = await resolvePythonWithDemucs();
    const second = await resolvePythonWithDemucs();
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/adapters-node/src/acquire/resolve-python.test.ts`
Expected: FAIL——`hasDemucs`/`resolvePythonWithDemucs`/`resetResolvedDemucsPythonCache` 不存在。

- [ ] **Step 3: 实现 `resolvePythonWithDemucs`**

在 `resolve-python.ts` 里，把共享候选列表加上 `.venv-demucs/bin/python3`（放在
`process.env.YT2X_PYTHON` 之后、Homebrew 路径之前——这个 venv 是 `docs/USAGE.md` 里专门装
demucs/faster-whisper 的，应该比裸系统 Python 优先命中）：

```ts
const CANDIDATES = [
  process.env.YT2X_PYTHON,
  // .venv-demucs 是 docs/USAGE.md 引导用户创建的专用 venv（demucs + faster-whisper），
  // 应该比裸系统 Python 优先命中这两项能力探测。
  ".venv-demucs/bin/python3",
  // Prefer Homebrew /opt paths before bare "python3" so agent shells whose
  // PATH puts /usr/bin first still find a Pillow-capable interpreter.
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "python3",
  "python",
].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
```

在文件末尾（`resetResolvedFasterWhisperPythonCache` 之后）追加，逐字跟随
`hasFasterWhisper`/`resolvePythonWithFasterWhisper`/`resetResolvedFasterWhisperPythonCache` 的结构：

```ts
/**
 * demucs（配音背景音分离）同样是可选、重依赖——探测不到必须优雅降级，不能让整条流水线崩溃。
 */
export const hasDemucs = async (bin: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["-c", "import demucs; print('ok')"],
      { timeout: 10_000, env: process.env },
    );
    return stdout.includes("ok");
  } catch {
    return false;
  }
};

let cachedDemucsPython: string | undefined;
let resolveDemucsPromise: Promise<string | undefined> | undefined;

export const resolvePythonWithDemucs = async (): Promise<string | undefined> => {
  if (cachedDemucsPython !== undefined) return cachedDemucsPython;
  if (resolveDemucsPromise !== undefined) return resolveDemucsPromise;

  resolveDemucsPromise = (async () => {
    for (const bin of CANDIDATES) {
      if (!(await isExecutable(bin))) continue;
      if (await hasDemucs(bin)) {
        cachedDemucsPython = bin;
        return bin;
      }
    }
    return undefined;
  })();

  try {
    return await resolveDemucsPromise;
  } finally {
    resolveDemucsPromise = undefined;
  }
};

/** Test helper: clear the cache between cases. */
export const resetResolvedDemucsPythonCache = (): void => {
  cachedDemucsPython = undefined;
  resolveDemucsPromise = undefined;
};
```

在 `packages/adapters-node/src/acquire/index.ts` 里加一行导出（跟其他 `export { x } from "./y.js";`
风格一致，放在任意位置都行，建议紧跟 `sanitizeVideoId` 那行之后）：

```ts
export { resolvePythonWithDemucs } from "./resolve-python.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/adapters-node/src/acquire/resolve-python.test.ts`
Expected: PASS，全部用例（含新增 4 个）通过。

- [ ] **Step 5: Commit**

```bash
git add packages/adapters-node/src/acquire/resolve-python.ts \
  packages/adapters-node/src/acquire/resolve-python.test.ts \
  packages/adapters-node/src/acquire/index.ts
git commit -m "Add resolvePythonWithDemucs capability probe"
```

---

### Task 2: `dub` / `pipeline --dub` 自动探测 demucs Python，不再强制 `--python-path`

**Files:**

- Modify: `packages/cli/src/orchestrator/native-dub.ts`
- Modify: `packages/cli/src/orchestrator/native-dub.test.ts`
- Modify: `packages/cli/src/orchestrator/native-pipeline.ts`
- Modify: `packages/cli/src/orchestrator/native-pipeline.test.ts`

**Interfaces:**

- Consumes: `resolvePythonWithDemucs(): Promise<string | undefined>`（Task 1 产出，从
  `@yt2x/adapters-node` 导入）。
- 不改变 `probeDemucs` 自身的签名——它还是接受 `{ pythonPath？, runner？, signal？ }`，只是两个
  调用点在拼这个入参前，先在 `flags.pythonPath`/`args.control.pythonPath` 未显式给出时尝试自动探测。

- [ ] **Step 1: 在 `native-dub.test.ts` 里注册 `resolvePythonWithDemucsMock` 并写失败测试**

在文件顶部 hoisted mock 声明区（`probeDemucsMock` 旁边）加一行：

```ts
const resolvePythonWithDemucsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => undefined),
);
```

在 `vi.mock("@yt2x/adapters-node", ...)` 的返回对象里加一行（跟 `probeDemucs: probeDemucsMock,`
相邻）：

```ts
    resolvePythonWithDemucs: resolvePythonWithDemucsMock,
```

在 `beforeEach` 里加两行重置（跟 `probeDemucsMock.mockClear();` 相邻）：

```ts
  resolvePythonWithDemucsMock.mockClear();
  resolvePythonWithDemucsMock.mockResolvedValue(undefined);
```

在文件末尾新增一个 describe 块，复用「separates Demucs into dub/work/demucs for a time window」
这个已验证能跑通到 demucs 探测步骤的 fixture（同一套 mock 返回值、同一套临时目录搭建）：

```ts
describe("executeNativeDub demucs python auto-detection", () => {
  const setupDemucsFixture = async (): Promise<{
    outRoot: string;
    articleRoot: string;
    videoId: string;
  }> => {
    guardMock.mockResolvedValue({
      hasBurnedSubtitles: false,
      hasChineseBurnedSubtitles: false,
      shouldSkipBurn: false,
    });
    generateDubScriptMock.mockResolvedValue({
      script: {
        version: 2,
        videoId: "abc12345678",
        sourceWords: "video/full.local.en.words.json",
        rewriteModel: "test-model",
        droppedCount: 0,
        lines: [
          {
            index: 1,
            startMs: 1_000,
            endMs: 2_000,
            targetDurationMs: 1_000,
            text: "窗内句",
            sourceText: "Inside the window.",
            cueIndices: [1],
          },
        ],
      },
      warnings: [],
      translatedCount: 1,
      droppedCount: 0,
    });
    synthesizeDubLinesMock.mockResolvedValue({
      report: {
        version: 1,
        videoId: "abc12345678",
        engine: "edge-tts",
        voice: "test-voice",
        lineCount: 1,
        medianRatio: 1,
        overflowCount: 0,
        totalDriftMs: 0,
        lines: [
          {
            index: 1,
            targetDurationMs: 1_000,
            synthesizedMs: 1_000,
            ratio: 1,
            charCount: 3,
            audioFile: "lines/0001.mp3",
          },
        ],
      },
      warnings: [],
    });
    separateDemucsMock.mockResolvedValue({ noVocalsPath: "/tmp/no_vocals.wav", skipped: false });

    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-native-dub-demucs-python-"));
    const outRoot = path.join(root, "downloads");
    const articleRoot = path.join(root, "articles");
    const videoId = "abc12345678";
    const dubDir = path.join(articleRoot, videoId, "dub");
    await mkdir(path.join(outRoot, videoId, "video"), { recursive: true });
    await mkdir(path.join(articleRoot, videoId, "video"), { recursive: true });
    await mkdir(dubDir, { recursive: true });
    await writeFile(path.join(outRoot, videoId, "video", "full.mp4"), "original");
    await writeFile(
      path.join(outRoot, videoId, "video", "full.local.en.words.json"),
      JSON.stringify([
        { word: "Inside", start: 1.0, end: 1.3 },
        { word: "the", start: 1.3, end: 1.5 },
        { word: "window.", start: 1.5, end: 2.0 },
      ]),
      "utf8",
    );
    return { outRoot, articleRoot, videoId };
  };

  it("passes the auto-detected demucs Python path to probeDemucs when --python-path is omitted", async () => {
    const { outRoot, articleRoot, videoId } = await setupDemucsFixture();
    resolvePythonWithDemucsMock.mockResolvedValueOnce(".venv-demucs/bin/python3");
    probeDemucsMock.mockClear();

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      startMs: "0",
      endMs: "5000",
    });

    expect(code).toBe(0);
    expect(resolvePythonWithDemucsMock).toHaveBeenCalledOnce();
    expect(probeDemucsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: ".venv-demucs/bin/python3" }),
    );
  });

  it("does not auto-detect when --python-path is explicitly given", async () => {
    const { outRoot, articleRoot, videoId } = await setupDemucsFixture();
    resolvePythonWithDemucsMock.mockClear();
    probeDemucsMock.mockClear();

    const code = await executeNativeDub({
      videoId,
      outDir: outRoot,
      articleOutDir: articleRoot,
      startMs: "0",
      endMs: "5000",
      pythonPath: "/explicit/python3",
    });

    expect(code).toBe(0);
    expect(resolvePythonWithDemucsMock).not.toHaveBeenCalled();
    expect(probeDemucsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: "/explicit/python3" }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/cli/src/orchestrator/native-dub.test.ts`
Expected: FAIL——新用例断言 `resolvePythonWithDemucsMock` 被调用，但生产代码从未调用它
（`probeDemucsMock` 被调用时 `pythonPath` 是 `undefined`，不是 `.venv-demucs/bin/python3`）。

- [ ] **Step 3: 修改 `native-dub.ts` 的 demucs 探测调用点**

在顶部 `@yt2x/adapters-node` 的 import 块里加一行（放在 `resolveDubWordsPath,` 之后、
`resolveWatermarkUploaderId,` 之前，保持字母序）：

```ts
  resolvePythonWithDemucs,
```

把 demucs 探测调用（`if (needsVideo) { ... }` 块，当前只有一处 `pythonPath = await probeDemucs({...})`）
改成：

```ts
  if (needsVideo) {
    // Demucs 探测前置于后续计费调用（翻译 LLM / 调速 TTS）和分离本身
    try {
      const autoPythonPath =
        flags.pythonPath === undefined ? await resolvePythonWithDemucs() : undefined;
      pythonPath = await probeDemucs({
        ...(flags.pythonPath !== undefined
          ? { pythonPath: flags.pythonPath }
          : autoPythonPath !== undefined
            ? { pythonPath: autoPythonPath }
            : {}),
      });
    } catch (err: unknown) {
```

（`catch` 块及之后内容不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/cli/src/orchestrator/native-dub.test.ts`
Expected: PASS。

- [ ] **Step 5: 对 `native-pipeline.ts` 的预检探测点做同样的事——先写失败测试**

在 `native-pipeline.test.ts` 顶部 hoisted mock 区加一行（跟 `probeDemucsMock` 相邻）：

```ts
const resolvePythonWithDemucsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => undefined),
);
```

在 `vi.mock("@yt2x/adapters-node", ...)` 返回对象里加一行：

```ts
    resolvePythonWithDemucs: resolvePythonWithDemucsMock,
```

在 `beforeEach` 里加两行重置（跟 `probeDemucsMock.mockClear();` 相邻）：

```ts
  resolvePythonWithDemucsMock.mockClear();
  resolvePythonWithDemucsMock.mockResolvedValue(undefined);
```

紧跟在「fails fast before notes/article/transcription when demucs is unavailable」测试之后，
新增两个用例，复用同一套 `dubVid5` 风格 fixture：

```ts
  it("auto-detects a demucs-capable Python for the preflight probe when --python-path is not given", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-demucs-autodetect-"));
    const vid = "dubVid8";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));
    resolvePythonWithDemucsMock.mockResolvedValueOnce(".venv-demucs/bin/python3");

    const args = buildArgs({
      control: { outDir: outRoot, dub: true, dubEngine: "edge-tts" },
      stages: { acquire: "skip", notes: "auto", article: "auto", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(resolvePythonWithDemucsMock).toHaveBeenCalledOnce();
    expect(probeDemucsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: ".venv-demucs/bin/python3" }),
    );
  });

  it("does not auto-detect the preflight probe's Python when --python-path is explicitly given", async () => {
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-np-dub-demucs-explicit-path-"));
    const vid = "dubVid9";
    await mkdir(path.join(outRoot, vid), { recursive: true });
    await writeFile(path.join(outRoot, vid, "metadata.json"), JSON.stringify({ id: vid, title: "a" }));
    resolvePythonWithDemucsMock.mockClear();

    const args = buildArgs({
      control: {
        outDir: outRoot,
        dub: true,
        dubEngine: "edge-tts",
        pythonPath: "/explicit/python3",
      },
      stages: { acquire: "skip", notes: "auto", article: "auto", publish: "skip" },
    });

    const code = await runNativePipeline({ args, monorepoRoot: "/tmp/yt2x-monorepo" });
    expect(code).toBe(0);
    expect(resolvePythonWithDemucsMock).not.toHaveBeenCalled();
    expect(probeDemucsMock).toHaveBeenCalledWith(
      expect.objectContaining({ pythonPath: "/explicit/python3" }),
    );
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run packages/cli/src/orchestrator/native-pipeline.test.ts`
Expected: FAIL，原因同 Step 2。

- [ ] **Step 7: 修改 `native-pipeline.ts` 的预检探测调用点**

在顶部 `@yt2x/adapters-node` 的 import 块里，`probeDemucs,` 那一行旁边加一行：

```ts
  resolvePythonWithDemucs,
```

把预检探测（`try { await probeDemucs({...}); } catch ...` 那一段）改成：

```ts
        try {
          const autoPythonPath =
            args.control.pythonPath === undefined ? await resolvePythonWithDemucs() : undefined;
          await probeDemucs({
            ...(args.control.pythonPath !== undefined
              ? { pythonPath: args.control.pythonPath }
              : autoPythonPath !== undefined
                ? { pythonPath: autoPythonPath }
                : {}),
          });
        } catch (err: unknown) {
```

（`catch` 块内容不变。）

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run packages/cli/src/orchestrator/native-pipeline.test.ts`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/orchestrator/native-dub.ts \
  packages/cli/src/orchestrator/native-dub.test.ts \
  packages/cli/src/orchestrator/native-pipeline.ts \
  packages/cli/src/orchestrator/native-pipeline.test.ts
git commit -m "Auto-detect demucs-capable Python before requiring --python-path"
```

---

### Task 3: 统一 TTS 引擎默认值为 `edge-tts`

**Files:**

- Modify: `packages/cli/src/args/pipeline.ts:147-148`
- Modify: `packages/cli/src/commands/pipeline.ts:63`
- Modify: `packages/cli/src/args/commander-pipeline-flags.test.ts:100-107`

**Interfaces:** 无新符号；纯改默认值常量和一处断言。

- [ ] **Step 1: 改测试断言，先让它反映期望行为（此时会失败）**

把 `commander-pipeline-flags.test.ts` 里这个用例：

```ts
  it("maps --dub and defaults dubEngine to elevenlabs", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      dub: true,
    });
    expect(args.control.dub).toBe(true);
    expect(args.control.dubEngine).toBe("elevenlabs");
  });
```

改成：

```ts
  it("maps --dub and defaults dubEngine to edge-tts", () => {
    const args = parseCommanderPipelineFlags({
      urls: ["https://example.com/video"],
      dub: true,
    });
    expect(args.control.dub).toBe(true);
    expect(args.control.dubEngine).toBe("edge-tts");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/cli/src/args/commander-pipeline-flags.test.ts`
Expected: FAIL——`args.control.dubEngine` 实际是 `"elevenlabs"`。

- [ ] **Step 3: 改 schema 默认值和相关文案**

`packages/cli/src/args/pipeline.ts`，把：

```ts
  /** 配音引擎；pipeline --dub 默认 elevenlabs（成片），可改 edge-tts。 */
  dubEngine: z.enum(["edge-tts", "elevenlabs"]).default("elevenlabs"),
```

改成：

```ts
  /** 配音引擎；与独立 dub 命令一致，默认 edge-tts（免费、无需凭据）；有 ElevenLabs 账号时可改。 */
  dubEngine: z.enum(["edge-tts", "elevenlabs"]).default("edge-tts"),
```

`packages/cli/src/commands/pipeline.ts` 第 63 行，把：

```ts
      "With --dub: TTS engine edge-tts|elevenlabs (default elevenlabs for pipeline deliverables)",
```

改成：

```ts
      "With --dub: TTS engine edge-tts (default) | elevenlabs",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/cli/src/args/commander-pipeline-flags.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑一次全量 pipeline 相关测试，确认没有别的地方依赖旧默认值**

Run: `npx vitest run packages/cli/src/args/pipeline.test.ts packages/cli/src/orchestrator/native-pipeline.test.ts`
Expected: PASS（这两个文件里现存的 dub 相关用例全部显式传了 `dubEngine`，理论上不受默认值影响；
如果有遗漏，此步会暴露）。

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/args/pipeline.ts \
  packages/cli/src/commands/pipeline.ts \
  packages/cli/src/args/commander-pipeline-flags.test.ts
git commit -m "Default pipeline --dub-engine to edge-tts, matching the standalone dub command"
```

---

### Task 4: `packages/core` 交付枚举校验模块

**Files:**

- Create: `packages/core/src/domain/pipeline/delivery.ts`
- Create: `packages/core/src/domain/pipeline/delivery.test.ts`
- Modify: `packages/core/src/domain/pipeline/index.ts`

**Interfaces:**

- Produces:
  - `DeliverModeSchema: ZodEnum<["none","zh-srt","zh-burned","bilingual-srt","bilingual-burned","dubbed"]>`,
    `type DeliverMode`
  - `FromModeSchema: ZodEnum<["youtube","transcribe","local","local-words","file"]>`, `type FromMode`
  - `AUTO_FROM: "auto"`, `type FromResolution = FromMode | "auto"`
  - `class DeliveryConflictError extends Error`
  - `assertFromCompatibleWithDeliver(deliver: DeliverMode, from: FromMode): void`——矛盾时抛
    `DeliveryConflictError`
  - `resolveFrom(deliver: DeliverMode, explicitFrom: FromMode | undefined): FromResolution`
- 这些符号是纯函数、零 I/O，不依赖本仓库任何其他模块。Plan 2 会把它们接进新的 `yt2x video`
  命令；本任务不做任何接线。

设计说明（写代码时保留在文件顶部的模块级注释里，因为这是非显而易见的 WHY）：

- 六档取值、五通道取值直接对应 `CONTEXT.md`「交付物」表和「字幕通道」表——改这两张表时要
  同步改这里的枚举。
- `assertFromCompatibleWithDeliver` 里 `local-words` 双向绑定 `dubbed`
  （`dubbed` 必须搭配它、非 `dubbed` 禁止选它）是这次实现在 ADR-0006 文字之上做的推断：ADR 原文
  只举了 `dubbed + youtube` 一个反例，没有明说非 dubbed 场景下选 `local-words` 该怎么办。这里选择
  报错而不是静默改写，跟 ADR-0006 Decision #3「显式矛盾一律报错，绝不静默改写」的精神一致——
  `local-words` 除了服务配音没有别的用途，允许它在非 dubbed 场景下悄悄退化成 `local` 只会重新
  制造一次「参数传了但没按字面生效」。

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/domain/pipeline/delivery.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  assertFromCompatibleWithDeliver,
  DeliverModeSchema,
  DeliveryConflictError,
  FromModeSchema,
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/domain/pipeline/delivery.test.ts`
Expected: FAIL——`./delivery.js` 不存在。

- [ ] **Step 3: 实现 `delivery.ts`**

创建 `packages/core/src/domain/pipeline/delivery.ts`：

```ts
import { z } from "zod";

/** 见 CONTEXT.md「交付物」六档；改表要同步改这里。 */
export const DeliverModeSchema = z.enum([
  "none",
  "zh-srt",
  "zh-burned",
  "bilingual-srt",
  "bilingual-burned",
  "dubbed",
]);
export type DeliverMode = z.infer<typeof DeliverModeSchema>;

/** 见 CONTEXT.md「字幕通道」五条；改表要同步改这里。 */
export const FromModeSchema = z.enum(["youtube", "transcribe", "local", "local-words", "file"]);
export type FromMode = z.infer<typeof FromModeSchema>;

/** `--from` 未显式给出时的解析结果之一：沿用现有 auto 探测（YouTube 优先，找不到退到 transcribe）。 */
export const AUTO_FROM = "auto" as const;
export type FromResolution = FromMode | typeof AUTO_FROM;

export class DeliveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryConflictError";
  }
}

/**
 * `dubbed` 是唯一需要词级时间戳的交付档（CONTEXT.md「字幕通道」），因此是唯一强制通道的档位；
 * `local-words` 反过来也只服务 `dubbed`——非 dubbed 场景选它没有意义，报错而不是静默退化成
 * `local`（ADR-0006 Decision #3：显式矛盾一律报错，绝不静默改写）。
 */
export const assertFromCompatibleWithDeliver = (deliver: DeliverMode, from: FromMode): void => {
  if (deliver === "dubbed" && from !== "local-words") {
    throw new DeliveryConflictError(
      `--deliver dubbed --from ${from} 无法配音：该通道没有词级时间戳。` +
        `改用 --from local-words（先跑 yt2x subtitle-tools transcribe-local）。`,
    );
  }
  if (deliver !== "dubbed" && from === "local-words") {
    throw new DeliveryConflictError(
      `--deliver ${deliver} --from local-words 没有意义：local-words 只服务 --deliver dubbed。` +
        `改用 --from local 读句级本地转录。`,
    );
  }
};

/**
 * 解析本次交付实际要用的字幕来源通道。显式传 --from 时只做矛盾校验；未传时按交付档给出隐含
 * 默认——dubbed 隐含 local-words（配音的唯一前提），其余档位维持现有 auto 探测行为不变。
 */
export const resolveFrom = (
  deliver: DeliverMode,
  explicitFrom: FromMode | undefined,
): FromResolution => {
  if (explicitFrom !== undefined) {
    assertFromCompatibleWithDeliver(deliver, explicitFrom);
    return explicitFrom;
  }
  return deliver === "dubbed" ? "local-words" : AUTO_FROM;
};
```

把 `packages/core/src/domain/pipeline/index.ts` 从：

```ts
export * from "./state.js";
```

改成：

```ts
export * from "./delivery.js";
export * from "./state.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/domain/pipeline/delivery.test.ts`
Expected: PASS，19 个用例全过。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain/pipeline/delivery.ts \
  packages/core/src/domain/pipeline/delivery.test.ts \
  packages/core/src/domain/pipeline/index.ts
git commit -m "Add --deliver/--from validation module (ADR-0006 core, not wired in yet)"
```

---

## 完成后的验证

```bash
npx tsc -b
npx eslint packages/adapters-node/src/acquire/resolve-python.ts \
  packages/adapters-node/src/acquire/index.ts \
  packages/cli/src/orchestrator/native-dub.ts \
  packages/cli/src/orchestrator/native-pipeline.ts \
  packages/cli/src/args/pipeline.ts \
  packages/cli/src/commands/pipeline.ts \
  packages/core/src/domain/pipeline/delivery.ts \
  packages/core/src/domain/pipeline/index.ts
npx vitest run
```

全部通过、无新增 lint 警告即完成。

## 这份计划之后是什么（Plan 2，尚未写）

ADR-0005 的命令树切分（新建 `yt2x video`/`yt2x text`，删除 `pipeline`/`acquire`/`subtitle`，
`single-stage-projection.ts` 退休）和 ADR-0006 剩下的一半（把本计划的 `delivery.ts` 接进真实的
`--deliver`/`--from` CLI 参数、缺失转录自动补跑、`--subtitle-zh`/`--subtitle-bilingual`/
`--subtitle-burn-style`/`--dub` 四个旧参数删除）需要先完整读完 `native-pipeline.ts`
（754 行，acquire/notes/article/publish/dub 五阶段调度全在这一个文件）、
`execute-native-acquire.ts`（352 行）和 `native-acquire-from-pipeline-args.ts` 的精确调用时序，
才能写出不留占位符的任务拆解——这本身是下一次 `superpowers:writing-plans` 的工作量，不塞进本计划。
