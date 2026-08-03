import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWatermarkIo } from "./watermark.js";

/**
 * `yt2x watermark` attributes a video on its own. The source can come from a
 * known videoId (so the channel handle is read from the acquired metadata) or
 * from an arbitrary path (so a already-dubbed or externally edited cut can be
 * attributed too).
 */
describe("resolveWatermarkIo", () => {
  const withDownloads = async (
    videoId: string,
    metadata: Record<string, unknown> | null,
  ): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-cmd-"));
    const videoDir = path.join(root, videoId, "video");
    await mkdir(videoDir, { recursive: true });
    await writeFile(path.join(videoDir, "full.mp4"), "video");
    if (metadata !== null) {
      await writeFile(
        path.join(root, videoId, "metadata.json"),
        JSON.stringify(metadata),
      );
    }
    return root;
  };

  it("defaults a --video-id run to the acquired full.mp4 and credits its channel", async () => {
    const outDir = await withDownloads("abc12345678", { uploader_id: "@nateherk" });

    const io = await resolveWatermarkIo({ videoId: "abc12345678", outDir });

    expect(io.inputPath).toBe(path.join(outDir, "abc12345678", "video", "full.mp4"));
    expect(io.watermarkVideo).toBe("@nateherk");
  });

  it("writes beside the source with a .watermarked suffix by default", async () => {
    const outDir = await withDownloads("abc12345678", null);

    const io = await resolveWatermarkIo({ videoId: "abc12345678", outDir });

    expect(path.basename(io.outputPath)).toBe("full.watermarked.mp4");
  });

  it("honors an explicit --output-path", async () => {
    const outDir = await withDownloads("abc12345678", null);

    const io = await resolveWatermarkIo({
      videoId: "abc12345678",
      outDir,
      outputPath: "/tmp/custom.mp4",
    });

    expect(io.outputPath).toBe(path.resolve("/tmp/custom.mp4"));
  });

  it("accepts a bare --input outside the pipeline layout and leaves the channel line empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-input-"));
    const input = path.join(dir, "edited.mp4");
    await writeFile(input, "video");

    const io = await resolveWatermarkIo({ input });

    expect(io.inputPath).toBe(input);
    expect(io.outputPath).toBe(path.join(dir, "edited.watermarked.mp4"));
    expect(io.watermarkVideo).toBeUndefined();
  });

  /**
   * A dubbed cut lives at <articleRoot>/<videoId>/video/full.zh-dubbed.mp4, so the
   * videoId is already in the path. Making the user repeat it as --video-id just to
   * get the channel credit is a trap: the run silently produces a one-line watermark.
   */
  it("infers the videoId from an --input under the <id>/video/ layout", async () => {
    const outDir = await withDownloads("abc12345678", { uploader_id: "@mattpocockuk" });
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-articles-"));
    const dubbedDir = path.join(articleRoot, "abc12345678", "video");
    await mkdir(dubbedDir, { recursive: true });
    const input = path.join(dubbedDir, "full.zh-dubbed.mp4");
    await writeFile(input, "video");

    const io = await resolveWatermarkIo({ input, outDir });

    expect(io.watermarkVideo).toBe("@mattpocockuk");
  });

  it("leaves the channel line empty when the inferred videoId has no acquired metadata", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-nometa-"));
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-articles2-"));
    const dubbedDir = path.join(articleRoot, "zz99999999", "video");
    await mkdir(dubbedDir, { recursive: true });
    const input = path.join(dubbedDir, "full.zh-dubbed.mp4");
    await writeFile(input, "video");

    const io = await resolveWatermarkIo({ input, outDir });

    expect(io.watermarkVideo).toBeUndefined();
  });

  it("lets an explicit --video-id win over what the input path implies", async () => {
    const outDir = await withDownloads("abc12345678", { uploader_id: "@nateherk" });
    await withDownloads("zz99999999", { uploader_id: "@someone" });
    const articleRoot = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-articles3-"));
    const dubbedDir = path.join(articleRoot, "zz99999999", "video");
    await mkdir(dubbedDir, { recursive: true });
    const input = path.join(dubbedDir, "full.zh-dubbed.mp4");
    await writeFile(input, "video");

    const io = await resolveWatermarkIo({ videoId: "abc12345678", outDir, input });

    expect(io.watermarkVideo).toBe("@nateherk");
  });

  it("lets --input override the videoId's default source while keeping its channel credit", async () => {
    const outDir = await withDownloads("abc12345678", { uploader_id: "@nateherk" });
    const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-override-"));
    const input = path.join(dir, "dubbed.mp4");
    await writeFile(input, "video");

    const io = await resolveWatermarkIo({ videoId: "abc12345678", outDir, input });

    expect(io.inputPath).toBe(input);
    expect(io.watermarkVideo).toBe("@nateherk");
  });

  it("rejects a run that names neither a videoId nor an input", async () => {
    await expect(resolveWatermarkIo({})).rejects.toThrow(/--video-id|--input/);
  });

  it("rejects a --video-id whose acquired video is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yt2x-wm-missing-"));
    await mkdir(path.join(root, "abc12345678", "video"), { recursive: true });

    await expect(
      resolveWatermarkIo({ videoId: "abc12345678", outDir: root }),
    ).rejects.toThrow(/no source video/i);
  });
});
