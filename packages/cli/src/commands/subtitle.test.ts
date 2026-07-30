import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSubtitleAudit, executeSubtitleRepair } from "./subtitle.js";

const sourceSrt = `1
00:00:00,000 --> 00:00:02,000
Ship Codex safely.
`;
const zhSrt = `1
00:00:00,000 --> 00:00:02,000
安全交付 Codex。
`;
const bilingualSrt = `1
00:00:00,000 --> 00:00:02,000
安全交付 Codex。
Ship Codex safely.
`;
const testVideoId = "testvideo01";

const prepareArtifacts = async (): Promise<{
  outDir: string;
  articleOutDir: string;
  reportPath: string;
  measureLayout: () => Promise<[]>;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-subtitle-audit-"));
  const outDir = path.join(root, "downloads");
  const articleOutDir = path.join(root, "articles");
  const downloadDir = path.join(outDir, testVideoId);
  const articleVideoDir = path.join(articleOutDir, testVideoId, "video");
  await mkdir(downloadDir, { recursive: true });
  await mkdir(articleVideoDir, { recursive: true });
  await writeFile(path.join(downloadDir, "full.en.srt"), sourceSrt);
  await writeFile(path.join(articleVideoDir, "full.en.srt"), sourceSrt);
  await writeFile(path.join(articleVideoDir, "full.zh.srt"), zhSrt);
  await writeFile(path.join(articleVideoDir, "full.bilingual.srt"), bilingualSrt);
  await writeFile(
    path.join(articleVideoDir, "full.bilingual.semantic.json"),
    JSON.stringify({
      sourceSha256: createHash("sha256").update(sourceSrt).digest("hex"),
    }),
  );
  return {
    outDir,
    articleOutDir,
    reportPath: path.join(articleVideoDir, "full.bilingual.audit.json"),
    measureLayout: async () => [],
  };
};

describe("executeSubtitleAudit", () => {
  it("reads subtitle artifacts and writes the JSON audit report", async () => {
    const fixture = await prepareArtifacts();

    const exitCode = await executeSubtitleAudit(testVideoId, fixture);
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
      verdict: string;
      issues: unknown[];
    };

    expect(exitCode).toBe(0);
    expect(report).toEqual({ verdict: "pass", issues: [] });
  });

  it("returns exit 2 in strict mode when content audit fails", async () => {
    const fixture = await prepareArtifacts();
    const manifestPath = path.join(
      fixture.articleOutDir,
      testVideoId,
      "video",
      "full.bilingual.semantic.json",
    );
    await writeFile(manifestPath, JSON.stringify({ sourceSha256: "stale" }));

    const exitCode = await executeSubtitleAudit(testVideoId, {
      ...fixture,
      strict: true,
    });
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
      verdict: string;
    };

    expect(exitCode).toBe(2);
    expect(report.verdict).toBe("fail");
  });

  it("includes renderer measurements in the CLI audit report", async () => {
    const fixture = await prepareArtifacts();

    await executeSubtitleAudit(testVideoId, {
      ...fixture,
      measureLayout: async () => [{
        cueIndex: 1,
        severity: "hard" as const,
        lineCount: 3,
      }],
    } as Parameters<typeof executeSubtitleAudit>[1] & {
      measureLayout: () => Promise<Array<{
        cueIndex: number;
        severity: "hard";
        lineCount: number;
      }>>;
    });
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
      issues: Array<{ code: string }>;
    };

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "hard-layout" }),
        expect.objectContaining({ code: "line-count" }),
      ]),
    );
  });

  it("reads the local-channel source SRT (not full.en.srt) when --source-channel local is passed", async () => {
    const fixture = await prepareArtifacts();
    const downloadDir = path.join(fixture.outDir, testVideoId);
    // A stale/mismatched full.en.srt is left in place on purpose: if audit
    // ever fell back to reading it instead of the local-channel source, the
    // sourceSha256 check (computed against the local source at generation
    // time) would fail — regression coverage for the Commander parent/child
    // flag-name collision that silently dropped this flag entirely.
    await writeFile(path.join(downloadDir, "full.en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nWrong source.\n");
    await writeFile(path.join(downloadDir, "full.local.en.srt"), sourceSrt);
    const manifestPath = path.join(
      fixture.articleOutDir,
      testVideoId,
      "video",
      "full.bilingual.semantic.json",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({ sourceSha256: createHash("sha256").update(sourceSrt).digest("hex") }),
    );

    const exitCode = await executeSubtitleAudit(testVideoId, { ...fixture, sourceChannel: "local" });
    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
      verdict: string;
      issues: unknown[];
    };

    expect(exitCode).toBe(0);
    expect(report).toEqual({ verdict: "pass", issues: [] });
  });
});

describe("executeSubtitleRepair", () => {
  const repairVideoId = "testvideorp"; // sanitizeVideoId truncates to 11 chars — keep it exact
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.DEEPSEEK_API_KEY;
    // Neither cue below has a protected term or excessive cps, so
    // repairSubtitleArtifacts never actually calls the LLM — this key only
    // needs to satisfy config validation, never a real network call.
    process.env.DEEPSEEK_API_KEY = "test-key-not-real";
  });
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
  });

  const prepareRepairFixture = async (): Promise<{
    outDir: string;
    articleOutDir: string;
    reportPath: string;
    manifestPath: string;
    enSrtPath: string;
    zhSrtPath: string;
    bilingualSrtPath: string;
  }> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-subtitle-repair-"));
    const outDir = path.join(root, "downloads");
    const articleOutDir = path.join(root, "articles");
    const downloadDir = path.join(outDir, repairVideoId);
    const articleVideoDir = path.join(articleOutDir, repairVideoId, "video");
    await mkdir(downloadDir, { recursive: true });
    await mkdir(articleVideoDir, { recursive: true });

    // cue 2 is a 0.5s flash cue with a 0.5s dead gap before it — exactly
    // enough for fixFlashCues to absorb without touching cue 1 at all.
    const en = `1\n00:00:00,000 --> 00:00:03,000\nThis is a normal opening sentence.\n\n2\n00:00:03,500 --> 00:00:04,000\nShort.\n`;
    const zh = `1\n00:00:00,000 --> 00:00:03,000\n这是一句正常的开场白。\n\n2\n00:00:03,500 --> 00:00:04,000\n短。\n`;
    const bilingual = `1\n00:00:00,000 --> 00:00:03,000\n这是一句正常的开场白。\nThis is a normal opening sentence.\n\n2\n00:00:03,500 --> 00:00:04,000\n短。\nShort.\n`;

    const enSrtPath = path.join(articleVideoDir, "full.en.srt");
    const zhSrtPath = path.join(articleVideoDir, "full.zh.srt");
    const bilingualSrtPath = path.join(articleVideoDir, "full.bilingual.srt");
    await writeFile(path.join(downloadDir, "full.en.srt"), en);
    await writeFile(enSrtPath, en);
    await writeFile(zhSrtPath, zh);
    await writeFile(bilingualSrtPath, bilingual);
    const manifestPath = path.join(articleVideoDir, "full.bilingual.semantic.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        sourceSha256: createHash("sha256").update(en).digest("hex"),
        // Mirrors what a failed generation run actually leaves behind: this
        // is exactly the record that made the `subtitle` pipeline's own
        // cache check reject the repaired artifact and silently
        // re-translate from scratch on the next run, even without --force.
        status: "failed",
        stages: { translation: "done", alignment: "done", segmentation: "done", layout: "failed" },
        quality: { readyForBurn: false, issues: [{ code: "flash" }] },
        files: {
          en: { sha256: createHash("sha256").update(en).digest("hex") },
          zh: { sha256: createHash("sha256").update(zh).digest("hex") },
          bilingual: { sha256: createHash("sha256").update(bilingual).digest("hex") },
        },
      }),
    );
    return {
      outDir,
      articleOutDir,
      reportPath: path.join(articleVideoDir, "full.bilingual.audit.json"),
      manifestPath,
      enSrtPath,
      zhSrtPath,
      bilingualSrtPath,
    };
  };

  it("fixes a flash cue's timing and keeps en/zh/bilingual consistent on disk", async () => {
    const fixture = await prepareRepairFixture();

    const exitCode = await executeSubtitleRepair(repairVideoId, {
      outDir: fixture.outDir,
      articleOutDir: fixture.articleOutDir,
      measureLayout: async () => [],
    });

    expect(exitCode).toBe(0);
    const en = await readFile(fixture.enSrtPath, "utf8");
    const zh = await readFile(fixture.zhSrtPath, "utf8");
    const bilingual = await readFile(fixture.bilingualSrtPath, "utf8");
    // cue 2 absorbed the 0.5s dead gap before it (03,000 -> 03,500), and all
    // three files moved together.
    expect(en).toContain("00:00:03,000 --> 00:00:04,000");
    expect(zh).toContain("00:00:03,000 --> 00:00:04,000");
    expect(bilingual).toContain("00:00:03,000 --> 00:00:04,000");

    const report = JSON.parse(await readFile(fixture.reportPath, "utf8")) as {
      verdict: string;
      issues: Array<{ code: string }>;
    };
    expect(report.issues.some((i) => i.code === "flash")).toBe(false);
    // Regression coverage: the "after" audit must compare against the
    // freshly written full.en.srt, not the stale pre-repair copy that was
    // read at the top of the function — otherwise a real timing fix that
    // moved en/zh/bilingual together falsely reports as a mismatch between
    // them, since only the in-memory `enSrt` variable would be behind.
    expect(report.issues.some((i) => i.code === "bilingual-timing")).toBe(false);
    expect(report.verdict).not.toBe("fail");
  });

  it("refreshes full.bilingual.semantic.json so a later run's cache check accepts the repaired artifact", async () => {
    const fixture = await prepareRepairFixture();

    await executeSubtitleRepair(repairVideoId, {
      outDir: fixture.outDir,
      articleOutDir: fixture.articleOutDir,
      measureLayout: async () => [],
    });

    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
      status: string;
      stages: Record<string, string>;
      quality: { readyForBurn: boolean };
      files: Record<string, { sha256: string }>;
    };
    // Regression coverage: before this fix, repair patched the SRT files
    // but never touched this manifest — a subsequent `subtitle` run's own
    // cache check (readValidArticleCache) kept reading the ORIGINAL failed
    // record, judged the repaired artifact invalid, and silently
    // re-translated the whole video from scratch even without --force.
    expect(manifest.status).toBe("ready");
    expect(manifest.stages.layout).toBe("done");
    expect(manifest.quality.readyForBurn).toBe(true);
    const en = await readFile(fixture.enSrtPath, "utf8");
    const zh = await readFile(fixture.zhSrtPath, "utf8");
    const bilingual = await readFile(fixture.bilingualSrtPath, "utf8");
    expect(manifest.files.en!.sha256).toBe(createHash("sha256").update(en).digest("hex"));
    expect(manifest.files.zh!.sha256).toBe(createHash("sha256").update(zh).digest("hex"));
    expect(manifest.files.bilingual!.sha256).toBe(createHash("sha256").update(bilingual).digest("hex"));
  });
});
