import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageGeneratorPort } from "../llm/image-generator.js";
import type { PlatformFormatInput, PlatformFormatResult, WechatMetadata } from "./types.js";

const COVER_1_1 = "cover-1-1.png";
const COVER_WIDE = "cover-wide.png";

const METADATA_FILE = "wechat-metadata.json";

const downloadImage = async (url: string, destPath: string, _fetcher = fetch): Promise<void> => {
  let buffer: Buffer;
  if (url.startsWith("data:")) {
    const base64 = url.includes("base64,") ? url.slice(url.indexOf("base64,") + 7) : url.slice(url.indexOf(",") + 1);
    buffer = Buffer.from(base64, "base64");
  } else {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, buffer);
};

const generateCoverIfMissing = async (
  imageDir: string,
  filename: string,
  size: "1024x1024" | "1792x1024",
  prompt: string,
  headline: string,
  generator: ImageGeneratorPort,
): Promise<string> => {
  const destPath = path.join(imageDir, filename);

  // skip if already exists
  try {
    await readFile(destPath);
    return destPath;
  } catch {
    // file doesn't exist — generate it
  }

  const isWide = size === "1792x1024";
  const ratioSpec = isWide
    ? "16:9 landscape (1792×1024) — WeChat share cover, horizontal composition, title centered with side margins"
    : "1:1 square (1024×1024) — WeChat primary cover, title centered, bold and thumbnail-friendly";
  const fullPrompt = [
    `WeChat Official Account cover illustration. sketch-knowledge-kit visual style.`,
    `${ratioSpec}.`,
    `Warm paper background with subtle grain texture. Black marker linework, Anthropic orange (#E07030) accent highlights.`,
    `Hand-drawn typography for the title: "${headline}". Generous whitespace. Editorial cover feel.`,
    `${prompt}`,
    `No photorealistic elements, no gradients, no 3D renders. Clean, minimal, educational.`,
  ].join(" ");
  const result = await generator.generateImage({ prompt: fullPrompt, size });
  await downloadImage(result.url, destPath);
  return destPath;
};

export const formatWechatCovers = async (input: PlatformFormatInput): Promise<PlatformFormatResult> => {
  const articleDir = path.resolve(input.articleDir);
  const imageDir = path.join(articleDir, "wechat-format", "article", "images");

  let metadata: WechatMetadata | null = null;
  try {
    const raw = await readFile(path.join(articleDir, METADATA_FILE), "utf8");
    metadata = JSON.parse(raw) as WechatMetadata;
  } catch {
    // no metadata — skip cover generation
  }

  let imagesGenerated = 0;
  const files: string[] = [];

  if (metadata !== null && input.imageGenerator !== undefined) {
    const visualPrompt = metadata.cover.visual_prompt || metadata.title;
    const headline = metadata.cover.headline || metadata.title;

    // 1:1 square cover (WeChat primary cover)
    const cover1x1 = await generateCoverIfMissing(
      imageDir,
      COVER_1_1,
      "1024x1024",
      visualPrompt,
      headline,
      input.imageGenerator,
    );
    files.push(cover1x1);
    imagesGenerated++;

    // 16:9 wide cover (WeChat secondary / share cover)
    const coverWide = await generateCoverIfMissing(
      imageDir,
      COVER_WIDE,
      "1792x1024",
      visualPrompt + " 宽屏横向构图。",
      headline,
      input.imageGenerator,
    );
    files.push(coverWide);
    imagesGenerated++;
  }

  return {
    outputDir: imageDir,
    files,
    imagesGenerated,
  };
};
