import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageGeneratorPort } from "../llm/image-generator.js";
import type { PlatformFormatInput, PlatformFormatResult, WechatMetadata } from "./types.js";

const COVER_1_1 = "cover-1-1.png";
const COVER_WIDE = "cover-wide.png";

const METADATA_FILE = "wechat-format/wechat-metadata.json";

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

const tryReuseFromArticle = async (
  articleDir: string,
  sourceFile: string,
  destPath: string,
): Promise<boolean> => {
  const sourcePath = path.join(articleDir, "images", sourceFile);
  try {
    await stat(sourcePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
    return true;
  } catch {
    return false;
  }
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
  const articleImageDir = path.join(articleDir, "images");

  let metadata: WechatMetadata | null = null;
  try {
    const raw = await readFile(path.join(articleDir, METADATA_FILE), "utf8");
    metadata = JSON.parse(raw) as WechatMetadata;
  } catch {
    // no metadata — skip cover generation
  }

  let imagesGenerated = 0;
  const files: string[] = [];

  let headline = "";
  let visualPrompt = "";
  if (metadata !== null) {
    headline = metadata.cover.headline || metadata.title;
    visualPrompt = metadata.cover.visual_prompt || metadata.title;
  } else {
    const match = input.articleMd.match(/^#\s+(.+)$/m);
    headline = match?.[1] ?? "";
    visualPrompt = headline;
  }

  const cover1x1 = path.join(imageDir, COVER_1_1);
  try {
    await readFile(cover1x1);
    files.push(cover1x1);
  } catch {
    const reused = await tryReuseFromArticle(articleDir, "cover.png", cover1x1)
      || await tryReuseFromArticle(articleDir, "cover.webp", cover1x1)
      || await tryReuseFromArticle(articleDir, "cover.jpg", cover1x1)
      || await tryReuseFromArticle(articleDir, "cover.jpeg", cover1x1);
    if (reused) {
      files.push(cover1x1);
    } else if (input.imageGenerator !== undefined) {
      const generated = await generateCoverIfMissing(
        imageDir,
        COVER_1_1,
        "1024x1024",
        visualPrompt,
        headline,
        input.imageGenerator,
      );
      files.push(generated);
      imagesGenerated++;
    }
  }

  const coverWide = path.join(imageDir, COVER_WIDE);
  try {
    await readFile(coverWide);
    files.push(coverWide);
  } catch {
    let reused = false;
    try {
      const entries = await readdir(articleImageDir);
      const sceneImage = entries.find((file) => /scene.*\.(png|jpg|jpeg|webp)$/i.test(file));
      if (sceneImage !== undefined) {
        reused = await tryReuseFromArticle(articleDir, sceneImage, coverWide);
      }
    } catch {
      // No article image directory; fall through to cover reuse/generation.
    }
    if (!reused) {
      reused = await tryReuseFromArticle(articleDir, "cover.png", coverWide)
        || await tryReuseFromArticle(articleDir, "cover.webp", coverWide)
        || await tryReuseFromArticle(articleDir, "cover.jpg", coverWide)
        || await tryReuseFromArticle(articleDir, "cover.jpeg", coverWide);
    }
    if (reused) {
      files.push(coverWide);
    } else if (input.imageGenerator !== undefined) {
      const generated = await generateCoverIfMissing(
        imageDir,
        COVER_WIDE,
        "1792x1024",
        visualPrompt + " 宽屏横向构图。",
        headline,
        input.imageGenerator,
      );
      files.push(generated);
      imagesGenerated++;
    }
  }

  return {
    outputDir: imageDir,
    files,
    imagesGenerated,
  };
};
