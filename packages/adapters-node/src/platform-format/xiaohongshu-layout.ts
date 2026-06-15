import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmPort } from "@yt2x/core";
import type { PlatformFormatInput, PlatformFormatResult, XiaohongshuMetadata } from "./types.js";

const METADATA_FILE = "xiaohongshu-metadata.json";
const OUTPUT_DIR = "xiaohongshu-format";
const IMAGE_PREFIX = "section-";
const IMAGE_EXT = ".png";
const XHS_IMAGE_SIZE = "1024x1792" as const; // 3:4 portrait – Xiaohongshu feed
const PROMPTS_FILE = "prompts.json";

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

const splitBodyIntoSections = (body: string): string[] => {
  const raw = body.split(/\n\n(?=#|【|[A-Z一-鿿]{2,}[：:])/);
  if (raw.length >= 3) return raw.filter((s) => s.trim().length > 0);
  const parts = body.split(/\n{2,}/).filter((s) => s.trim().length > 0);
  if (parts.length <= 2) return parts;
  const merged: string[] = [];
  let buf = "";
  for (const part of parts) {
    if (buf.length + part.length < 400) {
      buf = buf.length > 0 ? buf + "\n\n" + part : part;
    } else {
      if (buf.length > 0) merged.push(buf);
      buf = part;
    }
  }
  if (buf.length > 0) merged.push(buf);
  return merged;
};

const generatePromptViaLlm = async (
  llm: LlmPort,
  model: string,
  topic: string,
  sectionText: string,
  sectionIndex: number,
): Promise<string> => {
  const systemPrompt = [
    `You are creating illustration prompts following the sketch-knowledge-kit visual system.`,
    ``,
    `Shared visual identity across all illustrations:`,
    `- Warm paper texture background with subtle grain`,
    `- Black marker/ink linework, hand-drawn quality`,
    `- Anthropic orange (#E07030) as the sole accent color for highlights, underlines, key labels`,
    `- Hand-drawn typography for titles and labels`,
    `- Generous whitespace, slight scanned/printed feel`,
    `- Clean, minimal, educational editorial quality`,
    ``,
    `Illustration role (per section): specific feature explanation, action focus, 3-second comprehension.`,
    `Each illustration must anchor to the section's core argument with a concrete visual metaphor.`,
    ``,
    `For each section, produce ONE detailed image-generation prompt that includes:`,
    `1. Visual metaphor tied to the content`,
    `2. Composition and spatial layout (what goes where)`,
    `3. Specific UI elements, diagrams, or objects to draw`,
    `4. Where to place text labels (hand-drawn typography)`,
    `5. Where to use orange accent (sparingly, for emphasis only)`,
    ``,
    `CRITICAL: Every prompt MUST specify the aspect ratio — "3:4 portrait/vertical (1080×1440 for Xiaohongshu feed)".`,
    ``,
    `Output ONLY the English prompt, 150-300 words. No markdown formatting, no JSON wrapper.`,
  ].join("\n");

  const userPrompt = [
    `Create a sketch-knowledge-kit illustration prompt for section #${sectionIndex + 1} of a Xiaohongshu article.`,
    ``,
    `Article topic: ${topic}`,
    ``,
    `Section content to illustrate:`,
    `${sectionText}`,
    ``,
    `MUST specify: 3:4 portrait/vertical format (1080×1440) for Xiaohongshu feed.`,
    `Orange (#E07030) accent only — do NOT make it the dominant color.`,
  ].join("\n");

  const resp = await llm.chat({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.85,
    maxTokens: 1200,
  });
  return (resp.content ?? "").trim();
};

const placeholderSvg = (index: number, title: string, width = 800, height = 800): string => {
  const colors = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9"];
  const bg = colors[index % colors.length]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${bg}" opacity="0.12"/>
  <text x="${width / 2}" y="${height / 2 - 12}" text-anchor="middle" font-family="Georgia,serif" font-size="24" fill="${bg}">配图 ${index + 1}</text>
  <text x="${width / 2}" y="${height / 2 + 20}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#999">在 ChatGPT 粘贴 Prompt 生成</text>
</svg>`;
};

const renderHtml = (
  title: string,
  sections: Array<{ imageFile: string; text: string; hasImage: boolean; prompt: string }>,
): string => {
  const cards = sections
    .map(
      (s, i) => {
        const imageHtml = s.hasImage
          ? `<img src="${s.imageFile}" alt="配图${i + 1}" />`
          : `<div class="placeholder-img" id="ph-${i}">${placeholderSvg(i, title, 800, 800)}</div>`;

        const promptHtml = s.prompt
          ? `<button class="copy-prompt-btn" data-prompt="${s.prompt.replace(/"/g, "&quot;").replace(/'/g, "&#39;")}" data-idx="${i}" onclick="copyPrompt(${i})">📋 复制 Prompt</button>
             <a class="chatgpt-link" href="https://chatgpt.com/?q=${encodeURIComponent(s.prompt)}" target="_blank">🤖 打开 ChatGPT</a>`
          : "";

        return `
    <div class="card">
      ${imageHtml}
      <div class="card-actions">${promptHtml}</div>
      <div class="card-text">${s.text.replace(/\n/g, "<br>")}</div>
    </div>`;
      },
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - 小红书排版预览</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; background: #f5f5f5; }
.toolbar { position: fixed; top: 0; left: 0; right: 0; background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-bottom: 1px solid #e0e0e0; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
.toolbar h2 { font-size: 16px; color: #333; }
.toolbar span { font-size: 12px; color: #999; }
.container { max-width: 560px; margin: 72px auto 40px; padding: 0 16px; }
.card { background: #fff; border-radius: 12px; overflow: hidden; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.card img, .placeholder-img { width: 100%; display: block; }
.placeholder-img svg { width: 100%; height: auto; display: block; }
.card-actions { display: flex; gap: 8px; padding: 10px 14px; background: #fafafa; border-bottom: 1px solid #eee; }
.copy-prompt-btn { padding: 6px 12px; font-size: 12px; border: 1px solid #ddd; background: #fff; border-radius: 6px; cursor: pointer; color: #555; }
.copy-prompt-btn:hover { background: #f0f0f0; }
.chatgpt-link { padding: 6px 12px; font-size: 12px; border: 1px solid #74aa9c; background: #74aa9c; color: #fff; border-radius: 6px; text-decoration: none; }
.chatgpt-link:hover { background: #5c9082; }
.card-text { padding: 16px 18px; font-size: 15px; color: #333; line-height: 1.8; }
</style>
</head>
<body>
<div class="toolbar">
  <h2>${title}</h2>
  <span>小红书图文排版 · ${sections.length} 张配图</span>
</div>
<div class="container">
${cards}
</div>
<script>
const prompts = ${JSON.stringify(sections.map((s) => s.prompt))};
function copyPrompt(idx) {
  const text = prompts[idx];
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('[data-idx="' + idx + '"]');
    if (btn) { btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制 Prompt', 1500); }
  });
}
</script>
</body>
</html>`;
};

// extract image paths from article.md markdown: ![alt](images/xxx.png)
const extractArticleImages = (markdown: string): string[] => {
  const images: string[] = [];
  const regex = /!\[.*?\]\(images\/([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(markdown)) !== null) {
    images.push(m[1]!);
  }
  return images;
};

export const formatXiaohongshuLayout = async (input: PlatformFormatInput): Promise<PlatformFormatResult> => {
  const articleDir = path.resolve(input.articleDir);
  const outputDir = path.join(articleDir, OUTPUT_DIR);
  const imageDir = path.join(outputDir, "images");
  const sourceImageDir = path.join(articleDir, "images");

  let metadata: XiaohongshuMetadata | null = null;
  try {
    const raw = await readFile(path.join(articleDir, METADATA_FILE), "utf8");
    metadata = JSON.parse(raw) as XiaohongshuMetadata;
  } catch {
    // no metadata — use article.md directly
  }

  const body = metadata?.body ?? input.articleMd;
  const title = metadata?.title ?? "";
  const sections = splitBodyIntoSections(body);
  const articleImages = extractArticleImages(input.articleMd);

  // try to reuse X article cover as section-01
  let coverReused = false;
  const coverSources = ["cover.png", "cover.webp", "cover.jpg"];
  for (const coverFile of coverSources) {
    if (coverReused) break;
    try {
      await copyFile(path.join(sourceImageDir, coverFile), path.join(imageDir, "section-01.png"));
      coverReused = true;
    } catch { /* not found */ }
  }

  const files: string[] = [];
  let imagesGenerated = 0;
  const sectionHasImage: boolean[] = [];
  const sectionPrompts: string[] = [];

  // generate prompts via LLM (always if available)
  const hasLlm = input.llm !== undefined && input.llmModel !== undefined;
  for (let i = 0; i < sections.length; i++) {
    let prompt = "";
    if (hasLlm) {
      const sectionText = sections[i]!.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 400);
      const topic = metadata?.cover.headline || metadata?.title || title;
      try {
        prompt = await generatePromptViaLlm(input.llm!, input.llmModel!, topic, sectionText, i);
      } catch {
        prompt = "";
      }
    }
    sectionPrompts.push(prompt);
  }

  // save prompts
  const promptsPath = path.join(outputDir, PROMPTS_FILE);
  await mkdir(outputDir, { recursive: true });
  await writeFile(promptsPath, JSON.stringify(sectionPrompts, null, 2), "utf8");
  files.push(promptsPath);

  // generate images
  for (let i = 0; i < sections.length; i++) {
    const imageFile = IMAGE_PREFIX + String(i + 1).padStart(2, "0") + IMAGE_EXT;
    const destPath = path.join(imageDir, imageFile);
    let hasImage = false;

    try { await readFile(destPath); hasImage = true; } catch { /* ok */ }

    // AI generation with LLM prompt if available, else template
    if (!hasImage && input.imageGenerator !== undefined && metadata !== null) {
      let prompt = sectionPrompts[i]!;
      if (!prompt) {
        const sectionText = sections[i]!.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 200);
        prompt = [
          `Editorial illustration for Xiaohongshu. Warm paper texture, black ink linework, orange (#E07030) accent.`,
          `Topic: ${(metadata?.cover?.headline) || title}. Content: ${sectionText}`,
          `3:4 portrait/vertical. Clean composition, generous whitespace. No photorealism, no 3D.`,
        ].join(" ");
      }
      try {
        const result = await input.imageGenerator.generateImage({ prompt, size: XHS_IMAGE_SIZE });
        await downloadImage(result.url, destPath);
        hasImage = true;
        imagesGenerated++;
      } catch { /* fall through */ }
    }

    // fallback: copy from article images
    if (!hasImage && i < articleImages.length) {
      const sourceFile = articleImages[i]!;
      try {
        await mkdir(imageDir, { recursive: true });
        await copyFile(path.join(sourceImageDir, sourceFile), destPath);
        hasImage = true;
      } catch { /* ok */ }
    }

    if (hasImage) files.push(destPath);
    sectionHasImage.push(hasImage);
  }

  // render HTML
  const sectionData = sections.map((text, i) => ({
    imageFile: "images/" + IMAGE_PREFIX + String(i + 1).padStart(2, "0") + IMAGE_EXT,
    text,
    hasImage: sectionHasImage[i] ?? false,
    prompt: sectionPrompts[i] ?? "",
  }));
  const html = renderHtml(title, sectionData);
  const htmlPath = path.join(outputDir, "article.html");
  await writeFile(htmlPath, html, "utf8");
  files.push(htmlPath);

  return { outputDir, files, imagesGenerated };
};
