import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findDownloadsPollution,
  formatDownloadsPollutionReport,
} from "../../../../scripts/check-downloads-readonly.mjs";

const tmpRoot = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "yt2x-dl-check-"));

describe("findDownloadsPollution", () => {
  it("reports clean on a baseline of one source mp4 per videoId", async () => {
    const root = await tmpRoot();
    for (const id of ["vidAAAA1111", "vidBBBB2222"]) {
      await mkdir(path.join(root, id, "video"), { recursive: true });
      await writeFile(path.join(root, id, "video", "full.mp4"), "source");
      await writeFile(path.join(root, id, "video", "full.en.srt"), "1\n");
    }

    await expect(findDownloadsPollution(root)).resolves.toEqual([]);
  });

  it("follows a symlinked downloads root instead of silently scanning an empty path", async () => {
    const real = await tmpRoot();
    const linkParent = await tmpRoot();
    const link = path.join(linkParent, "downloads");
    await mkdir(path.join(real, "vidCCCC3333", "video"), { recursive: true });
    await writeFile(path.join(real, "vidCCCC3333", "video", "full.zh-burned.mp4"), "burned");
    await symlink(real, link);

    const findings = await findDownloadsPollution(link);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /burned/iu.test(f.relativePath))).toBe(true);
  });

  it("allows full.mp4 alongside clip.mp4 (acquire contract) but flags burned/dubbed names", async () => {
    const root = await tmpRoot();
    const id = "vidDDDD4444";
    await mkdir(path.join(root, id, "video"), { recursive: true });
    await writeFile(path.join(root, id, "video", "full.mp4"), "a");
    await writeFile(path.join(root, id, "video", "clip.mp4"), "b");
    await writeFile(path.join(root, id, "video", "full.zh-dubbed.mp4"), "c");

    const findings = await findDownloadsPollution(root);
    expect(formatDownloadsPollutionReport(findings)).toMatch(/dubbed/iu);
    expect(findings.every((f) => !/clip\.mp4/iu.test(f.relativePath))).toBe(true);
    expect(findings).toHaveLength(1);
  });
});
