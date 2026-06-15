import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageGeneratorPort } from "../llm/image-generator.js";
import type { PlatformFormatInput, PlatformFormatResult, WechatMetadata } from "./types.js";

const COVER_1_1 = "cover-1-1.png";
const COVER_WIDE = "cover-wide.png";
const METADATA_FILE = "wechat-metadata.json";

const downloadImage = async (url: string, destPath: string): Promise<void> => {
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

// try to reuse an existing image from the X article
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

const generateCover = async (
  imageDir: string,
  filename: string,
  size: "1024x1024" | "1792x1024",
  prompt: string,
  headline: string,
  generator: ImageGeneratorPort,
): Promise<string> => {
  const destPath = path.join(imageDir, filename);
  try { await readFile(destPath); return destPath; } catch { /* generate */ }

  const isWide = size === "1792x1024";
  const ratioSpec = isWide
    ? "16:9 landscape (1792×1024) — WeChat share cover"
    : "1:1 square (1024×1024) — WeChat primary cover";
  const fullPrompt = [
    `WeChat Official Account cover. sketch-knowledge-kit visual style. ${ratioSpec}.`,
    `Warm paper texture, black marker linework, orange (#E07030) accent.`,
    `Hand-drawn typography for title: "${headline}". Editorial feel.`,
    `${prompt}`,
    `No photorealism, no 3D, no gradients.`,
  ].join(" ");

  const result = await generator.generateImage({ prompt: fullPrompt, size });
  await downloadImage(result.url, destPath);
  return destPath;
};

export const formatWechatCovers = async (input: PlatformFormatInput): Promise<PlatformFormatResult> => {
  const articleDir = path.resolve(input.articleDir);
  const imageDir = path.join(articleDir, "wechat-format", "article", "images");
  const articleImageDir = path.join(articleDir, "images");
  const files: string[] = [];
  let imagesGenerated = 0;

  let headline = "";
  let visualPrompt = "";
  try {
    const raw = await readFile(path.join(articleDir, METADATA_FILE), "utf8");
    const meta = JSON.parse(raw) as WechatMetadata;
    headline = meta.cover.headline || meta.title;
    visualPrompt = meta.cover.visual_prompt || meta.title;
  } catch {
    // use article title as fallback
    const match = input.articleMd.match(/^#\s+(.+)$/m);
    headline = match?.[1] ?? "";
    visualPrompt = headline;
  }

  const hasGenerator = input.imageGenerator !== undefined;

  // ── 1:1 cover ──
  const dest1x1 = path.join(imageDir, COVER_1_1);
  try { await readFile(dest1x1); files.push(dest1x1); } catch {
    // try reuse article cover first
    const reused = await tryReuseFromArticle(articleDir, "cover.png", dest1x1)
      || await tryReuseFromArticle(articleDir, "cover.webp", dest1x1)
      || await tryReuseFromArticle(articleDir, "cover.jpg", dest1x1);
    if (reused) {
      files.push(dest1x1);
    } else if (hasGenerator) {
      const p = await generateCover(imageDir, COVER_1_1, "1024x1024", visualPrompt, headline, input.imageGenerator!);
      files.push(p);
      imagesGenerated++;
    }
  }

  // ── 16:9 wide cover ──
  const destWide = path.join(imageDir, COVER_WIDE);
  try { await readFile(destWide); files.push(destWide); } catch {
    // try to find a wide scene image from the article
    let reused = false;
    try {
      const entries = await readdir(articleImageDir);
      const wideImg = entries.find((f: string) => /scene.*\.(png|jpg|jpeg|webp)/i.test(f));
      if (wideImg) {
        reused = await tryReuseFromArticle(articleDir, wideImg, destWide);
      }
    } catch { /* article images dir doesn't exist */ }
    if (!reused) {
      reused = await tryReuseFromArticle(articleDir, "cover.png", destWide)
        || await tryReuseFromArticle(articleDir, "cover.webp", destWide);
    }
    if (reused) {
      files.push(destWide);
    } else if (hasGenerator) {
      const p = await generateCover(imageDir, COVER_WIDE, "1792x1024", visualPrompt + " 宽屏横向构图。", headline, input.imageGenerator!);
      files.push(p);
      imagesGenerated++;
    }
  }

  return { outputDir: imageDir, files, imagesGenerated };
};
