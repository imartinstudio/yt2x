import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeSubtitleAudit } from "./subtitle.js";

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
});
