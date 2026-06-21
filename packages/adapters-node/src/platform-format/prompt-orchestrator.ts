import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmPort } from "@yt2x/core";
import type { PlatformFormatInput, PlatformFormatResult } from "./types.js";

// ── HTML/URL helpers ──

/** HTML-escape a string for use in element text content (NOT safe for unquoted attribute values — does not escape quotes). */
const _esc = (s: string): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Encode prompt for ChatGPT URL, truncated so the total URL stays well under browser limits.
 * CJK chars encode to ~9 bytes each, so we cap at ~166 CJK chars (~1500 encoded bytes).
 */
const _chatGptUrl = (prompt: string): string => {
  const maxEncoded = 1500;
  let result = "";
  for (const ch of prompt) {
    const encoded = encodeURIComponent(ch);
    if (result.length + encoded.length > maxEncoded) break;
    result += encoded;
  }
  return result;
};

// ── platform-specific spec ──

type PlatformSpec = {
  label: string;
  coverRatios: Array<{ label: string; size: string; description: string }>;
  illustrationRatio: string;
  outputDir: string;
};

const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  x: {
    label: "X",
    coverRatios: [
      { label: "X 封面 5:2", size: "1500×600", description: "5:2 landscape — X article cover card, bold visual metaphor, thumbnail-friendly" },
    ],
    illustrationRatio: "16:9 landscape",
    outputDir: "x-format",
  },
  wechat: {
    label: "WeChat Official Account (微信公众号)",
    coverRatios: [
      { label: "公众号封面 1:1", size: "1024×1024", description: "1:1 square — WeChat primary cover, title centered, bold and thumbnail-friendly" },
      { label: "公众号封面 16:9", size: "1792×1024", description: "16:9 landscape — WeChat share cover, horizontal composition, title centered with side margins" },
    ],
    illustrationRatio: "16:9 landscape (primary) or 1:1 square",
    outputDir: "wechat-format",
  },
  xiaohongshu: {
    label: "Xiaohongshu (小红书)",
    coverRatios: [
      { label: "小红书封面 3:4", size: "1080×1440", description: "3:4 portrait/vertical — Xiaohongshu feed cover, eye-catching, title prominent" },
    ],
    illustrationRatio: "3:4 portrait (1080×1440 pixels)",
    outputDir: "xiaohongshu-format",
  },
  bilibili: {
    label: "Bilibili (哔哩哔哩)",
    coverRatios: [
      { label: "B站视频封面 16:9", size: "1920×1080", description: "16:9 landscape — Bilibili video cover, bold title, thumbnail-friendly, high contrast" },
    ],
    illustrationRatio: "16:9 landscape",
    outputDir: "bilibili-format",
  },
};

// ── LLM prompt generation ──

const _callLlm = async (llm: LlmPort, model: string, systemPrompt: string, userPrompt: string): Promise<string> => {
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

const COVER_SYSTEM_PROMPT = [
  `Create a cover image-generation prompt following the sketch-knowledge-kit visual system.`,
  `Fill in EVERY field below with specific, concrete content from the article. Leave NO field empty. Use EXACT Chinese label text for every element.`,
  ``,
  `REQUIRED STRUCTURE — fill all fields:`,
  ``,
  `Canvas: [ratio], [exact pixel dimensions].`,
  ``,
  `Article: "[full Chinese title]". Subtitle: "[key takeaway in Chinese]". Platform: [platform].`,
  ``,
  `Knowledge structure: [pick one: pipeline / timeline / comparison / hub-and-spoke / hierarchy / mind-map / process-flow]. Why: [1 sentence].`,
  ``,
  `Visual metaphor — describe a SINGLE cohesive scene with every element labeled in Chinese:`,
  `- Dominant central element: [what it is] labeled "[Chinese text]"`,
  `- Supporting elements (3-6): each with exact [what] and "[Chinese label]"`,
  `- Flow/connection between elements: [describe arrows/lines and their labels]`,
  ``,
  `Composition — exact layout:`,
  `- Title placement: [top/center/bottom], hand-drawn [bold/thin] marker, "[exact title text]", [size relative to canvas]`,
  `- Subtitle placement: [position], hand-drawn, "[exact subtitle]"`,
  `- Key labels: list EVERY hand-drawn Chinese label that appears, with its position`,
  ``,
  `Color system:`,
  `- Paper: #F5F0E8 with grain texture + scan noise`,
  `- Linework: black fine-tip marker, slight stroke variation`,
  `- Orange (#E67E22): used on exactly these 2-4 elements: [list them]`,
  `- Whitespace: approximately [X]% empty paper`,
  ``,
  `Typography: ALL text hand-drawn sketch-note style, marker-bleed effect, slight baseline irregularity. No computer fonts.`,
  ``,
  `Avoid: dark backgrounds, tech gradients, code editor windows, glossy UI, 3D shadows, real logos, sans-serif fonts, pure white #FFF, photographs, AI/robot clipart.`,
  ``,
  `Output ONLY the filled prompt. No JSON, no markdown, no explanation.`,
].join("\n");

const _ILLUSTRATION_SYSTEM_PROMPT = [
  `You are creating illustration prompts following the sketch-knowledge-kit visual system.`,
  ``,
  `Visual identity: Warm paper texture. Black marker/ink linework, hand-drawn. Anthropic orange (#E07030) as accent only. Hand-drawn typography. Generous whitespace. Slight scanned feel. Clean, educational editorial quality.`,
  ``,
  `Illustration role: specific feature explanation, action focus, 3-second comprehension.`,
  `Each illustration anchors to ONE section's core argument with a concrete visual metaphor.`,
  ``,
  `Include: visual metaphor, composition layout, specific elements to draw, text label placement, where orange accent goes (sparingly).`,
  ``,
  `CRITICAL: Every prompt MUST specify the aspect ratio and dimensions.`,
  ``,
  `Output ONLY the English prompt, 150-300 words. No markdown, no JSON.`,
].join("\n");

const splitBodyIntoSections = (body: string, platform?: string): string[] => {
  // XHS articles use **bold** headers + --- dividers, NOT ## headings.
  // Detect XHS format: has **bold** markers and fewer ## headings than --- dividers.
  const isXhsFormat = platform === "xiaohongshu" || (
    (body.match(/\*\*[^*]+\*\*/g)?.length ?? 0) >= 2 &&
    (body.match(/^##\s/gm)?.length ?? 0) < (body.match(/^---$/gm)?.length ?? 0)
  );

  if (isXhsFormat) {
    // Split on --- dividers, then on **bold** headers within each block
    const rawSections = body.split(/\n---\n/);
    const sections: string[] = [];
    for (const raw of rawSections) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Split on lines that START with **bold header**
      const subBlocks = trimmed.split(/\n(?=\*\*[^*]+\*\*)/);
      for (const block of subBlocks) {
        const b = block.trim();
        if (!b) continue;
        sections.push(b);
      }
    }
    return sections.length > 0 ? sections : [body.trim()].filter((s) => s.length > 0);
  }

  // Standard format: split on ## headings
  const headingRe = /^(?=##\s)/m;
  const raw = body.split(headingRe);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
};

// ── HTML render ──

const _renderPreviewHtml = (
  title: string,
  platformLabel: string,
  platformSpec: PlatformSpec,
  coverPrompts: Array<{ label: string; prompt: string; size: string }>,
  illustrationPrompts: Array<{ index: number; text: string; prompt: string }>,
): string => {
  const coverCards = coverPrompts
    .map(
      (c, i) => `
    <div class="card cover-card">
      <div class="card-header">
        <span class="badge">封面</span>
        <span class="ratio">${c.size}</span>
      </div>
      <div class="card-label">${c.label}</div>
      <div class="prompt-box">${_esc(c.prompt)}</div>
      <div class="card-actions">
        <button class="copy-btn" onclick="copyText(${i})">📋 复制 Prompt</button>
        <a class="chatgpt-btn" href="https://chatgpt.com/?q=${_chatGptUrl(c.prompt)}" target="_blank">🤖 打开 ChatGPT</a>
      </div>
    </div>`,
    )
    .join("\n");

  const illustrationCards = illustrationPrompts
    .map(
      (il, i) => {
        const idx = coverPrompts.length + i;
        return `
    <div class="card">
      <div class="card-header">
        <span class="badge ill">插图 ${il.index + 1}</span>
        <span class="ratio">${platformSpec.illustrationRatio}</span>
      </div>
      <div class="card-text">${il.text.replace(/\n/g, "<br>")}…</div>
      <div class="prompt-box">${_esc(il.prompt)}</div>
      <div class="card-actions">
        <button class="copy-btn" onclick="copyText(${idx})">📋 复制 Prompt</button>
        <a class="chatgpt-btn" href="https://chatgpt.com/?q=${_chatGptUrl(il.prompt)}" target="_blank">🤖 打开 ChatGPT</a>
      </div>
    </div>`;
      },
    )
    .join("\n");

  const allPrompts = [...coverPrompts.map((c) => c.prompt), ...illustrationPrompts.map((il) => il.prompt)];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - ${platformLabel} 编排预览</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; background: #f5f5f5; }
.toolbar { position: fixed; top: 0; left: 0; right: 0; background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-bottom: 1px solid #e0e0e0; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
.toolbar h2 { font-size: 17px; color: #333; }
.toolbar span { font-size: 12px; color: #999; }
.container { max-width: 680px; margin: 72px auto 40px; padding: 0 16px; }
.card { background: #fff; border-radius: 12px; overflow: hidden; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.cover-card { border-left: 3px solid #E07030; }
.card-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 0; }
.badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; background: #E07030; color: #fff; }
.badge.ill { background: #0e6f5c; }
.ratio { font-size: 11px; color: #999; }
.card-label { font-size: 15px; font-weight: 600; padding: 8px 16px 0; color: #333; }
.card-text { padding: 8px 16px; font-size: 13px; color: #666; line-height: 1.6; }
.prompt-box { margin: 8px 16px; padding: 12px 14px; background: #faf8f3; border: 1px solid #e8e3d5; border-radius: 8px; font-size: 12px; color: #555; line-height: 1.6; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
.card-actions { display: flex; gap: 8px; padding: 10px 16px 14px; }
.copy-btn { padding: 7px 14px; font-size: 12px; border: 1px solid #ddd; background: #fff; border-radius: 6px; cursor: pointer; color: #555; }
.copy-btn:hover { background: #f0f0f0; }
.chatgpt-btn { padding: 7px 14px; font-size: 12px; border: 1px solid #74aa9c; background: #74aa9c; color: #fff; border-radius: 6px; text-decoration: none; }
.chatgpt-btn:hover { background: #5c9082; }
.copy-all-bar { display: flex; gap: 10px; padding: 0 16px 24px; }
.copy-all-bar button { padding: 10px 24px; font-size: 14px; border: 2px solid #E07030; background: #fff; color: #E07030; border-radius: 8px; cursor: pointer; font-weight: 600; }
.copy-all-bar button:hover { background: #fff5f0; }
</style>
</head>
<body>
<div class="toolbar">
  <h2>${title}</h2>
  <span>${platformLabel} 编排 · ${coverPrompts.length} 封面 + ${illustrationPrompts.length} 插图</span>
</div>
<div class="container">
${coverCards}
${illustrationCards}
<div class="copy-all-bar">
  <button onclick="copyAll()">📋 复制全部 Prompt</button>
</div>
</div>
<script>
const allPrompts = ${JSON.stringify(allPrompts)};
function copyText(idx) {
  const text = allPrompts[idx];
  if (!text) return;
  navigator.clipboard.writeText(text);
  const btns = document.querySelectorAll('.copy-btn');
  if (btns[idx]) { btns[idx].textContent = '✅ 已复制'; setTimeout(() => btns[idx].textContent = '📋 复制 Prompt', 1500); }
}
function copyAll() {
  const text = allPrompts.map((p,i) => '--- Prompt ' + (i+1) + ' ---\n' + p).join('\n\n');
  navigator.clipboard.writeText(text);
  const btn = document.querySelector('.copy-all-bar button');
  btn.textContent = '✅ 已复制全部';
  setTimeout(() => btn.textContent = '📋 复制全部 Prompt', 2000);
}
</script>
</body>
</html>`;
};

// ── light preview from existing article images (no LLM) ──

export const previewExistingArticleImages = async (
  articleDir: string,
  platform: string,
  promptMap?: Map<number, string>,
): Promise<{ html: string; coverCount: number; illCount: number } | null> => {
  const { readdir, readFile: rf } = await import("node:fs/promises");
  // X: primary is root images/ (scene_*, cover.webp), fallback is x-format/images/ (x-table-*)
  // Other platforms: primary is <format-dir>/images/, fallback is root images/
  const platformImageDir = platform === "x" ? "images" : `${platform === "xiaohongshu" ? "xiaohongshu-format" : platform === "wechat" ? "wechat-format" : "bilibili-format"}/images`;
  const imageDir = path.join(articleDir, platformImageDir);
  const fallbackDir = platform === "x" ? path.join(articleDir, "x-format", "images") : path.join(articleDir, "images");
  let entries: string[] = [];
  try { entries = await readdir(imageDir); } catch { entries = []; }
  if (fallbackDir) {
    try { entries.push(...(await readdir(fallbackDir)).filter((f) => !entries.includes(f))); } catch { /* no fallback */ }
  }
  const imageSet = new Set(entries);

  // Read article text — prefer platform-specific files (which are cleaned copies without images)
  const articleFiles: Record<string, string> = { x: "x-format/x-article.md", xiaohongshu: "xiaohongshu-format/xiaohongshu-article.md", bilibili: "bilibili-format/video-info.md", wechat: "wechat-format/wechat-article.md" };
  const articleFile = articleFiles[platform] ?? "article.md";
  let articleText = "";
  let fellBackToMainArticle = false;
  try { articleText = await rf(path.join(articleDir, articleFile), "utf8"); } catch {
    try { articleText = await rf(path.join(articleDir, "article.md"), "utf8"); fellBackToMainArticle = true; } catch { /* no text */ }
  }
  if (!articleText) return null;

  // When XHS preview falls back to article.md (X's article), strip X image references
  // because XHS image galleries require 3:4 portrait — X's 16:9 images don't fit.
  if (platform === "xiaohongshu" && fellBackToMainArticle) {
    articleText = articleText.replace(/!\[.*?\]\(\.?\/?images\/[^)]+\)\n?/g, "");
    // also remove standalone cover/pairing image blocks in frontmatter-like regions
    articleText = articleText.replace(/\*\*封面\/配图建议\*\*[\s\S]*?(?=\*\*[^*]+\*\*|$)/g, "");
  }

  // Parse title
  const titleMatch = articleText.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? "文章预览";
  const articleTitleClean = title.replace(/\*\*/g, "");
  const platformLabel = { x: "X", wechat: "公众号", xiaohongshu: "小红书", bilibili: "B站" }[platform] ?? platform;
  const videoId = path.basename(articleDir);
  const platformSubdir = platform === "x" ? "" : (platform === "xiaohongshu" ? "xiaohongshu-format" : platform === "wechat" ? "wechat-format" : "bilibili-format");
  const imgUrl = (f: string) => "/api/file-image?videoId=" + encodeURIComponent(videoId) + "&file=" + encodeURIComponent(f) + (platformSubdir ? "&subdir=" + encodeURIComponent(platformSubdir) : "");
  const imgExists = (f: string) => imageSet.has(f);
  const imgRefRe = /!\[.*?\]\(\.?\/?images\/([^)]+)\)/g;

  // XHS image galleries require 3:4 portrait (1080×1440).
  // X's 16:9 landscape cover/illustrations are NOT suitable — never reuse X images for XHS.
  // Only show images explicitly referenced in the XHS article text itself.

  // Parse sections. For XHS articles (which use **bold** headers + --- dividers), use different logic.
  const isXhsArticle = platform === "xiaohongshu";
  const sections: Array<{ heading: string; body: string; images: string[] }> = [];
  let curHeading = "";
  let curBody: string[] = [];
  let curImages: string[] = [];
  let afterTitle = false;
  const lines = articleText.split("\n");

  if (isXhsArticle) {
    // XHS: split on `---` first, then on `**bold headers**` within each block
    const rawSections = articleText.split(/\n---\n/);
    for (const raw of rawSections) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Split on lines that START with **bold header**
      const subBlocks = trimmed.split(/\n(?=\*\*[^*]+\*\*)/);
      for (const block of subBlocks) {
        const b = block.trim();
        if (!b) continue;
        const boldMatch = b.match(/^\*\*(.+?)\*\*/);
        const heading = boldMatch
          ? boldMatch[1]!.replace(/[*_#`~]/g, "").trim()
          : "";
        const body = boldMatch ? b.slice(boldMatch[0]!.length).trim() : b;
        const imgs: string[] = [];
        let m: RegExpExecArray | null;
        imgRefRe.lastIndex = 0;
        while ((m = imgRefRe.exec(b)) !== null) { imgs.push(m[1]!); }
        sections.push({ heading, body, images: imgs });
      }
    }
  } else {
    // X / Bilibili: split on ## headings — use a fresh non-global regex per-line
    // to avoid lastIndex leaking from imgRefRe's g flag between iterations
    const _singleImgRe = /!\[.*?\]\(\.?\/?images\/([^)]+)\)/;
    for (const line of lines) {
      if (/^#\s/.test(line) && !afterTitle) { afterTitle = true; continue; }
      if (/^##\s/.test(line)) {
        if (curBody.length > 0 || curHeading || curImages.length > 0) {
          sections.push({ heading: curHeading, body: curBody.join("\n").trim(), images: [...curImages] });
        }
        curHeading = line.replace(/^##\s+/, "").replace(/\*\*/g, "");
        curBody = []; curImages = [];
      } else if (afterTitle) {
        const m = _singleImgRe.exec(line);
        if (m) { curImages.push(m[1]!); } else { curBody.push(line); }
      }
    }
    if (curBody.length > 0 || curHeading || curImages.length > 0) {
      sections.push({ heading: curHeading, body: curBody.join("\n").trim(), images: [...curImages] });
    }
  }

  // First image in article = cover
  const allImgs: string[] = [];
  for (const sec of sections) { for (const img of sec.images) { if (imgExists(img)) allImgs.push(img); } }
  const coverImg = allImgs.length > 0 ? allImgs[0]! : null;
  const usedImgs = new Set<string>(coverImg ? [coverImg] : []);

  // Count covers/illustrations for stats
  const coverCount = coverImg ? 1 : 0;
  const illCount = entries.filter(function (f) { return /\.(png|webp|jpg|jpeg)$/i.test(f) && !/^cover\./i.test(f); }).length;
  const hasSectionImages = allImgs.length > 1;
  const needsFormatNote = !promptMap && !hasSectionImages;

  const promptActions = function (promptText: string, opts?: { name?: string; label?: string; model?: string; promptId?: string }) {
    const nameHtml = opts?.name
      ? '<div class="ph-name">' + _esc(opts.name) + '</div>'
      : '';
    const modelHtml = opts?.model
      ? '<div class="prompt-model">' + _esc(opts.model) + '</div>'
      : '';
    const labelText = opts?.label ?? '📷 待生成 · 3:4';
    const promptIdAttr = opts?.promptId ? ' data-prompt-id="' + _esc(opts.promptId) + '"' : '';
    return '<div' + promptIdAttr + '>' +
      '<div class="ph-box">' + _esc(promptText) + modelHtml + '</div>' +
      nameHtml +
      '<div class="ph-row"><span class="ph-label">' + labelText + '</span>' +
      '<span class="ph-btns"><button class="ph-copy" onclick="navigator.clipboard.writeText(atob(this.dataset.promptB64))" data-prompt-b64="' + Buffer.from(promptText, "utf8").toString("base64") + '">📋 复制</button>' +
      '<a class="ph-chatgpt" href="https://chatgpt.com/?q=' + _chatGptUrl(promptText) + '" target="_blank">🤖 ChatGPT</a>' +
      '<button class="ph-edit-btn" onclick="editPrompt(this)" data-prompt-b64="' + Buffer.from(promptText, "utf8").toString("base64") + '" data-prompt-id="' + _esc(opts?.promptId ?? "") + '">✏️</button>' +
      '<button class="ph-upload-btn" onclick="selectPromptImage(this)">上传图片</button><input class="ph-upload-input" type="file" accept="image/jpeg,image/png,image/webp" data-prompt-id="' + _esc(opts?.promptId ?? "") + '" onchange="uploadPromptImage(this)" />' +
      '<button class="ph-del-btn" onclick="deletePrompt(this)" data-prompt-id="' + _esc(opts?.promptId ?? "") + '">🗑</button>' +
      '</span></div></div>';
  };

  const uploadedImageActions = (promptId: string) =>
    '<div class="uploaded-image-actions"><button class="ph-upload-btn" onclick="selectPromptImage(this)">替换图片</button><input class="ph-upload-input" type="file" accept="image/jpeg,image/png,image/webp" data-prompt-id="' + _esc(promptId) + '" onchange="uploadPromptImage(this)" /><button class="ph-del-btn" onclick="deletePromptImage(\'' + _esc(promptId) + '\')">删除图片</button></div>';

  const isXhs = platform === "xiaohongshu";
  let sectionHtml = "";

  if (isXhs) {
    // ── XHS layout: image gallery (top) + longform article (bottom) ──

    // Try reading prompts.json for cover prompt + illustration filenames
    let xhsCoverPrompt = "";
    let xhsCoverFilename = "cover.png";
    let xhsCoverName = "封面";
    let xhsModel = "";
    const xhsIllNames = new Map<number, string>();
    const xhsPromptIdsByFile = new Map<string, string>();
    try {
      const promptsPath = path.join(articleDir, "xiaohongshu-format", "prompts.json");
      const promptsRaw = await rf(promptsPath, "utf8");
      const prompts = JSON.parse(promptsRaw) as {
        model?: string;
        coverPrompts?: Array<{ prompt: string; filename?: string; name?: string }>;
        illustrationPrompts?: Array<{ index: number; prompt: string; filename?: string; name?: string }>;
      };
      xhsModel = prompts.model ?? "";
      xhsCoverPrompt = prompts.coverPrompts?.[0]?.prompt ?? "";
      xhsCoverFilename = prompts.coverPrompts?.[0]?.filename ?? "cover.png";
      xhsCoverName = prompts.coverPrompts?.[0]?.name ?? "封面";
      if (prompts.coverPrompts?.[0]?.filename) xhsPromptIdsByFile.set(prompts.coverPrompts[0].filename, "cover-0");
      for (const il of (prompts.illustrationPrompts ?? [])) {
        if (typeof il.name === "string" && il.name.trim().length > 0) {
          xhsIllNames.set(il.index, il.name.trim());
        }
        if (typeof il.filename === "string") xhsPromptIdsByFile.set(il.filename, "ill-" + il.index);
      }
    } catch { /* no prompts.json yet */ }

    // Gallery: collect cover + all section images + prompt placeholders
    const galleryItems: string[] = [];
    if (coverImg) {
      galleryItems.push('<div class="xhs-slide"><img src="' + imgUrl(coverImg) + '" alt="封面" class="xhs-slide-img" /><div class="img-label">封面 · ' + xhsCoverFilename + '</div>' + (xhsPromptIdsByFile.has(coverImg) ? uploadedImageActions(xhsPromptIdsByFile.get(coverImg)!) : "") + '</div>');
    } else if (xhsCoverPrompt) {
      galleryItems.push('<div class="xhs-slide xhs-slide-placeholder xhs-slide-cover">' + promptActions(xhsCoverPrompt, { name: xhsCoverName, label: '🎨 封面 · 3:4', model: xhsModel, promptId: 'cover-0' }) + '</div>');
    }
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]!;
      const imgs = sec.images.filter(function (f) { return imgExists(f) && !usedImgs.has(f); });
      for (const f of imgs) {
        galleryItems.push('<div class="xhs-slide"><img src="' + imgUrl(f) + '" alt="' + f + '" class="xhs-slide-img" /><div class="img-label">' + f + '</div>' + (xhsPromptIdsByFile.has(f) ? uploadedImageActions(xhsPromptIdsByFile.get(f)!) : "") + '</div>');
        usedImgs.add(f);
      }
      // Prompt placeholder for sections without images
      const secPrompt = promptMap?.get(i);
      if (secPrompt && imgs.length === 0) {
        const nm = xhsIllNames.get(i) ?? ('插图 ' + (i + 1));
        galleryItems.push('<div class="xhs-slide xhs-slide-placeholder">' + promptActions(secPrompt, { name: nm, label: '📷 3:4 竖版', model: xhsModel, promptId: 'ill-' + i }) + '</div>');
      }
    }
    // Inject slide counter into each gallery item before closing xhs-slide div
    const totalSlides = galleryItems.length;
    const galleryHtml = totalSlides > 0
      ? '<div class="xhs-gallery"><div class="xhs-gallery-label">📷 图集 · ' + totalSlides + ' 张</div><div class="xhs-gallery-scroll">' + galleryItems.map(function (item, idx) { return item.replace(/<\/div>$/, '<div class="slide-counter">' + (idx + 1) + '/' + totalSlides + '</div></div>'); }).join("") + '</div></div>'
      : "";

    // Article text: collect all headings + body text
    const articleBlocks: string[] = [];
    for (const sec of sections) {
      const h = sec.heading ? '<h3 class="xhs-sec-heading">' + sec.heading + '</h3>' : "";
      const b = sec.body
        ? '<div class="xhs-sec-body">' + sec.body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + '</div>'
        : "";
      if (h || b) articleBlocks.push('<div class="xhs-article-block">' + h + b + '</div>');
    }
    const articleHtml = articleBlocks.length > 0
      ? '<div class="xhs-article">' + articleBlocks.join("") + '</div>'
      : "";

    sectionHtml = galleryHtml + articleHtml;
  } else {
    // ── X / Bilibili / WeChat: inline images per section ──
    // Try reading prompts.json for cover prompt placeholder
    let nonXhsCoverPrompts: Array<{ prompt: string; label?: string }> = [];
    let nonXhsModel = "";
    try {
      const formatDir = platform === "x" ? "x-format" : platform === "wechat" ? "wechat-format" : "bilibili-format";
      const ppath = path.join(articleDir, formatDir, "prompts.json");
      const praw = await rf(ppath, "utf8");
      const pd = JSON.parse(praw) as { model?: string; coverPrompts?: Array<{ prompt: string; label?: string }> };
      nonXhsCoverPrompts = pd.coverPrompts ?? [];
      nonXhsModel = pd.model ?? "";
    } catch { /* no prompts.json */ }

    const coverHtml = coverImg
      ? '<div class="cover-wrap"><img src="' + imgUrl(coverImg) + '" alt="封面" class="cover-img" /><div class="img-label">封面</div></div>'
      : nonXhsCoverPrompts.map(function (cp, ci) {
          return '<div class="cover-wrap"><div data-prompt-id="cover-' + ci + '"><div class="ph-box ph-box-cover">' + _esc(cp.prompt) + (nonXhsModel ? '<div class="prompt-model">' + _esc(nonXhsModel) + '</div>' : '') + '</div><div class="ph-row"><span class="ph-label">🎨 封面' + (cp.label ? ' · ' + _esc(cp.label) : '') + '</span><span class="ph-btns"><button class="ph-copy" onclick="navigator.clipboard.writeText(atob(this.dataset.promptB64))" data-prompt-b64="' + Buffer.from(cp.prompt, "utf8").toString("base64") + '">📋 复制</button><a class="ph-chatgpt" href="https://chatgpt.com/?q=' + _chatGptUrl(cp.prompt) + '" target="_blank">🤖 ChatGPT</a><button class="ph-edit-btn" onclick="editPrompt(this)" data-prompt-b64="' + Buffer.from(cp.prompt, "utf8").toString("base64") + '" data-prompt-id="cover-' + ci + '">✏️</button><button class="ph-del-btn" onclick="deletePrompt(this)" data-prompt-id="cover-' + ci + '">🗑</button></span></div></div></div>';
        }).join("");

    // Count total prompt placeholders for X/bilibili preview counter
    let promptCounter = 0;
    const coverPromptCount = nonXhsCoverPrompts.length;
    const totalPrompts = coverPromptCount + sections.filter(function (_s, i) { return promptMap?.has(i); }).length;

    sectionHtml = (coverHtml ? coverHtml.replace(/<\/div>$/, '<div class="slide-counter">' + (++promptCounter) + '/' + totalPrompts + '</div></div>') : "") + sections.map(function (sec, i) {
      const h = sec.heading ? '<h3 class="sec-heading">' + sec.heading + '</h3>' : "";
      const b = sec.body
        ? '<div class="sec-body">' + sec.body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + '</div>'
        : "";
      const imgs = sec.images.filter(function (f) { return imgExists(f) && !usedImgs.has(f); });
      const imgHtml = imgs.map(function (f) { usedImgs.add(f); return '<img src="' + imgUrl(f) + '" alt="' + f + '" class="sec-img" /><div class="img-label">' + f + '</div>'; }).join("");
      const secPrompt = promptMap?.get(i);
      const promptHtml = (secPrompt && imgs.length === 0)
        ? '<div data-prompt-id="ill-' + i + '"><div class="ph-box">' + _esc(secPrompt) + (nonXhsModel ? '<div class="prompt-model">' + _esc(nonXhsModel) + '</div>' : '') + '</div>' +
          '<div class="ph-row"><span class="ph-label">📷 待生成</span>' +
          '<span class="ph-btns"><button class="ph-copy" onclick="navigator.clipboard.writeText(atob(this.dataset.promptB64))" data-prompt-b64="' + Buffer.from(secPrompt, "utf8").toString("base64") + '">📋 复制</button>' +
          '<a class="ph-chatgpt" href="https://chatgpt.com/?q=' + _chatGptUrl(secPrompt) + '" target="_blank">🤖 ChatGPT</a>' +
          '<button class="ph-edit-btn" onclick="editPrompt(this)" data-prompt-b64="' + Buffer.from(secPrompt, "utf8").toString("base64") + '" data-prompt-id="ill-' + i + '">✏️</button>' +
          '<button class="ph-del-btn" onclick="deletePrompt(this)" data-prompt-id="ill-' + i + '">🗑</button></span></div></div>'
        : "";
      let blockHtml = '<div class="sec-block">' + h + '<div class="sec-body">' + b + '</div>' + imgHtml + promptHtml + '</div>';
      if (promptHtml) {
        blockHtml = blockHtml.replace(/<\/div>$/, '<div class="slide-counter">' + (++promptCounter) + '/' + totalPrompts + '</div></div>');
      }
      return blockHtml;
    }).join("");
  }

  // CSS
  const isXhsCss = isXhs
    ? [
      "body{background:#fbf7f0;color:#2c2416}",
      "body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(255,36,66,.03) 0%,transparent 70%);pointer-events:none;z-index:0}",
      ".container{max-width:420px;margin:72px auto 48px;padding:0 16px;position:relative;z-index:1}",
      // gallery
      ".xhs-gallery{margin-bottom:24px}",
      ".xhs-gallery-label{font-family:'Georgia','Noto Serif SC','Songti SC',serif;font-size:11px;color:#b8a99a;margin-bottom:12px;padding:0 4px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:8px}",
      ".xhs-gallery-label::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#d9cbb8,transparent)}",
      ".xhs-gallery-scroll{display:flex;flex-direction:column;gap:12px}",
      ".xhs-slide{background:#fffdf8;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(44,36,22,.06),0 1px 3px rgba(44,36,22,.04);position:relative;transition:transform .2s ease,box-shadow .2s ease}",
      ".xhs-slide:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(44,36,22,.08),0 2px 6px rgba(44,36,22,.05)}",
      ".xhs-slide-placeholder{background:linear-gradient(168deg,#fffdf8 0%,#fdf9f2 40%,#faf4ea 100%);border:2px dashed #e8d5c0;padding:18px 14px 12px}",
      ".xhs-slide-placeholder .ph-box{margin:0;width:100%;aspect-ratio:3/4;max-height:none;border-color:#e8d5c0;background:rgba(255,252,247,.7);overflow-y:auto;padding:12px 12px;font-size:11px;line-height:1.55}",
      ".xhs-slide-img{width:100%;display:block}",
      // article
      ".xhs-article{background:#fffdf8;border-radius:14px;padding:28px 20px;box-shadow:0 4px 24px rgba(44,36,22,.06),0 1px 3px rgba(44,36,22,.04);line-height:1.95;position:relative}",
      ".xhs-article::before{content:'';position:absolute;top:0;left:20px;right:20px;height:3px;background:linear-gradient(90deg,#ff2442,#ff6b81,#ff2442);border-radius:0 0 3px 3px;opacity:.7}",
      ".xhs-article-block+.xhs-article-block{margin-top:32px}",
      ".xhs-sec-heading{font-family:'Georgia','Noto Serif SC','Songti SC',serif;font-size:17px;font-weight:700;color:#1a1008;margin-bottom:10px;letter-spacing:.01em;position:relative;padding-left:12px}",
      ".xhs-sec-heading::before{content:'';position:absolute;left:0;top:4px;bottom:4px;width:3px;background:#ff2442;border-radius:2px}",
      ".xhs-sec-body{font-size:14px;color:#4a3f33;letter-spacing:.01em}",
      ".xhs-sec-body p{margin-bottom:14px}",
      ".xhs-sec-body b,.xhs-sec-body strong{color:#1a1008;font-weight:650}",
      // common
      ".sec-heading{font-family:'Georgia','Noto Serif SC',serif;font-size:17px;font-weight:700;color:#1a1008;margin-bottom:10px}",
      ".sec-body{font-size:14px;line-height:1.95;color:#4a3f33}",
      ".sec-body p{margin-bottom:14px}",
      ".img-label{padding:8px 14px;font-size:10px;color:#b8a99a;text-align:right;background:linear-gradient(180deg,rgba(255,252,247,0),#faf4ea);font-family:'Georgia',serif;letter-spacing:.03em}",
      ".ph-box{background:linear-gradient(165deg,#fffdf8,#fdf9f2);border:2px dashed #e8d5c0;padding:18px 16px;font-size:12px;color:#6b5e4f;line-height:1.7;white-space:pre-wrap;max-height:200px;overflow-y:auto;border-radius:8px;font-family:'Georgia','Noto Serif SC',serif}",
      ".ph-name{font-size:14px;color:#1a1008;font-weight:700;padding:10px 14px 0;text-align:center;letter-spacing:.02em}",
      ".prompt-model{position:absolute;bottom:6px;right:10px;font-size:9px;color:#b8a99a;font-style:italic;opacity:.7}",
      ".xhs-slide-placeholder .ph-box{position:relative}",
      ".slide-counter{position:absolute;bottom:6px;left:10px;font-size:10px;color:#b8a99a;font-family:'Georgia',serif;opacity:.6}",
      ".ph-row{display:flex;align-items:center;justify-content:space-between;padding:6px 14px 4px}",
      ".ph-label{font-size:10px;color:#b8a99a;font-family:'SF Mono','ui-monospace',monospace;letter-spacing:.03em}",
      ".ph-btns{display:flex;gap:8px}",
      ".ph-copy,.ph-chatgpt{padding:4px 12px;font-size:11px;border-radius:6px;cursor:pointer;text-decoration:none;display:inline-block;font-weight:600;transition:all .15s ease}",
      ".ph-copy{border:1px solid #d9cbb8;background:#fffdf8;color:#6b5e4f}.ph-copy:hover{background:#faf4ea;border-color:#c4a98a}",
      ".ph-chatgpt{background:#ff2442;border:1px solid #ff2442;color:#fff}.ph-chatgpt:hover{background:#e01e38;border-color:#e01e38;box-shadow:0 2px 8px rgba(255,36,66,.25)}",
".ph-edit-ta{width:100%;min-height:100px;padding:10px;font-size:12px;line-height:1.6;border:2px solid #E07030;border-radius:6px;font-family:monospace;resize:vertical;box-sizing:border-box;background:#fffdf8;color:#333}",
".ph-edit-btn,.ph-upload-btn,.ph-del-btn{padding:2px 7px;font-size:13px;border-radius:4px;cursor:pointer;border:1px solid #ddd;background:#fff;line-height:1.4;transition:all .15s ease}.ph-upload-input{display:none}.uploaded-image-actions{display:flex;gap:8px;justify-content:flex-end;padding:8px 12px}",
".ph-edit-btn:hover{background:#f0f0f0}.ph-del-btn{color:#c0392b;border-color:#f5c6cb}.ph-del-btn:hover{background:#fde8e8}",
      // toolbar overrides
      ".toolbar{border-bottom-color:#e8d5c0;background:rgba(251,247,240,.92)}",
      ".toolbar h2{font-family:'Georgia','Noto Serif SC',serif}",
      ".note{background:#fffdf8;border:1px solid #e8d5c0;border-radius:10px;padding:14px 18px;margin-bottom:18px;font-size:12px;color:#8b8172;line-height:1.7;text-align:center}",
    ].join("")
    : [
      "body{background:#f5f5f5}",
      ".container{max-width:680px;margin:64px auto 40px;padding:0 16px}",
      ".article-body{background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);line-height:1.9}",
      ".sec-block+.sec-block{margin-top:28px}",
      ".sec-img{width:100%;display:block;margin:12px 0}",
      ".cover-wrap{background:#fff;border-radius:8px;overflow:hidden;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}",
      ".cover-img{width:100%;display:block}",
      ".sec-heading{font-size:16px;font-weight:700;color:#111;margin-bottom:8px}",
      ".sec-body{font-size:14px;line-height:1.9;color:#444}",
      ".sec-body p{margin-bottom:12px}",
      ".sec-body b,.sec-body strong{color:#111}",
      ".img-label{padding:6px 12px;font-size:11px;color:#bbb;text-align:right;background:#fafafa}",
      ".ph-box{background:linear-gradient(135deg,#faf8f3,#f5f1e8);border:2px dashed #e0d8c8;padding:18px 18px;font-size:12px;color:#666;line-height:1.65;white-space:pre-wrap;max-height:360px;overflow-y:auto;border-radius:6px}",
      ".ph-box-cover{max-height:480px;font-size:13px}",
      ".ph-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#fafafa;border-top:1px solid #f0f0f0}",
      ".ph-label{font-size:11px;color:#999}",
      ".ph-btns{display:flex;gap:6px}",
      ".ph-copy,.ph-chatgpt{padding:3px 10px;font-size:11px;border-radius:4px;cursor:pointer;text-decoration:none;display:inline-block}",
      ".ph-copy{border:1px solid #ddd;background:#fff;color:#666}.ph-copy:hover{background:#f0f0f0}",
      ".ph-chatgpt{border:1px solid #74aa9c;background:#74aa9c;color:#fff}.ph-chatgpt:hover{background:#5c9082}",
      ".ph-name{font-size:13px;color:#1a1a1a;font-weight:650;padding:4px 12px 0;text-align:center}",
      ".prompt-model{text-align:right;font-size:9px;color:#999;font-style:italic;margin-top:4px;opacity:.7}",
      ".cover-wrap .ph-box{position:relative}",
      ".slide-counter{font-size:10px;color:#999;font-family:'Georgia',serif;opacity:.6;text-align:right;padding:4px 12px 0}",
	      ".ph-edit-ta{width:100%;min-height:100px;padding:10px;font-size:12px;line-height:1.6;border:2px solid #E07030;border-radius:6px;font-family:monospace;resize:vertical;box-sizing:border-box;background:#fffdf8;color:#333}",
      ".ph-edit-btn,.ph-upload-btn,.ph-del-btn{padding:2px 7px;font-size:13px;border-radius:4px;cursor:pointer;border:1px solid #ddd;background:#fff;line-height:1.4;transition:all .15s ease}.ph-upload-input{display:none}.uploaded-image-actions{display:flex;gap:8px;justify-content:flex-end;padding:8px 12px}",
	      ".ph-edit-btn:hover{background:#f0f0f0}.ph-del-btn{color:#c0392b;border-color:#f5c6cb}.ph-del-btn:hover{background:#fde8e8}",
    ].join("");

  const h = [];
  h.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
  h.push("<title>" + articleTitleClean + " - " + platformLabel + "</title>");
  h.push("<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#333}");
  h.push(".toolbar{position:fixed;top:0;left:0;right:0;background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-bottom:1px solid #e0e0e0;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:100}");
  h.push(".toolbar h2{font-size:15px;color:#333;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar span{font-size:12px;color:#999}");
  h.push(isXhsCss);
  if (!isXhs) {
    h.push(".note{background:#fff;border-radius:8px;padding:14px 20px;margin-bottom:16px;font-size:13px;color:#888;line-height:1.6}");
  }
  h.push("</style></head>");
  h.push("<body><div class='toolbar'><h2>" + articleTitleClean + "</h2><span>" + platformLabel + (isXhs ? " · 图集+正文" : " · 图文预览") + "</span></div>");
  const noteHtml = needsFormatNote
    ? '<div class="note" style="background:#fff3e0;border:1px solid #E07030;text-align:center;font-size:14px;color:#E07030">📌 尚未排版，请先点击「排版」生成 prompt 和图片占位。</div>'
    : isXhs
      ? '<div class="note">📌 上图集 + 下正文。图片为 3:4 竖版，适合小红书图集滑动浏览。</div>'
      : '<div class="note">📌 以下为文章图文预览。封面在上，正文按文章顺序展示，插图按 markdown 位置内联。</div>';
  h.push('<div class="container">' + noteHtml);
  h.push(isXhs ? sectionHtml : '<div class="article-body">' + sectionHtml + '</div>');
  h.push("</div>");
  h.push('<script>var _VIDEO_ID=' + JSON.stringify(videoId) + ',_PLATFORM=' + JSON.stringify(platform) + ';' +
    'function _promptText(el){var t="";for(var j=0;j<el.childNodes.length;j++){if(el.childNodes[j].nodeType===3)t+=el.childNodes[j].textContent}return t||""}' + 'function editPrompt(b){' +
      'var c=b.closest(\'div[data-prompt-id]\'),o=c.querySelector(\'.ph-box\'),t=o.textContent,i=c.dataset.promptId;' +
      'var ta=document.createElement(\'textarea\');ta.className=\'ph-edit-ta\';ta.value=t;' +
      'o.replaceWith(ta);' +
      'b.textContent=\'💾\';b.onclick=function(){' +
        'var n=c.querySelector(\'.ph-edit-ta\').value;' +
        'fetch(\'/api/prompts/update\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},' +
          'body:JSON.stringify({videoId:_VIDEO_ID,platform:_PLATFORM,promptId:i,prompt:n})}).then(function(r){' +
          'if(r.ok){' +
            'var nb=document.createElement(\'div\');nb.className=\'ph-box\';nb.textContent=n;' +
            'c.querySelector(\'.ph-edit-ta\').replaceWith(nb);' +
            'b.textContent=\'✏️\';b.onclick=function(){editPrompt(b)};' +
          '}' +
        '});' +
      '};' +
      'var ca=document.createElement(\'button\');ca.textContent=\'↩️\';ca.className=\'ph-del-btn\';ca.onclick=function(){' +
        'ta.replaceWith(o);b.textContent=\'✏️\';b.onclick=function(){editPrompt(b)};ca.remove();' +
      '};' +
      'b.parentNode.insertBefore(ca,b.nextSibling);' +
    '}' +
    'var _activePromptImageInput=null;' +
    'function selectPromptImage(button){_activePromptImageInput=button.nextElementSibling;_activePromptImageInput.click()}' +
    'function uploadPromptImage(input){var file=input.files&&input.files[0];uploadPromptFile(file,input.dataset.promptId);input.value=\'\'}' +
    'function uploadPromptFile(file,i){' +
      'if(!file)return;' +
      'if([\'image/jpeg\',\'image/png\',\'image/webp\'].indexOf(file.type)<0){alert(\'仅支持 JPG、PNG、WebP 图片\');return;}' +
      'if(file.size>10*1024*1024){alert(\'图片不能超过 10MB\');return;}' +
      'var reader=new FileReader();reader.onload=function(){fetch(\'/api/prompts/image\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({videoId:_VIDEO_ID,platform:_PLATFORM,promptId:i,dataUrl:reader.result})}).then(function(r){return r.json().then(function(v){if(!r.ok)throw new Error(v.error||\'图片上传失败\');location.reload()})}).catch(function(e){alert(e.message)})};reader.readAsDataURL(file);' +
    '}' +
    'function deletePromptImage(i){if(!confirm(\'删除此图片？\'))return;fetch(\'/api/prompts/image/delete\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({videoId:_VIDEO_ID,platform:_PLATFORM,promptId:i})}).then(function(r){return r.json().then(function(v){if(!r.ok)throw new Error(v.error||\'删除图片失败\');location.reload()})}).catch(function(e){alert(e.message)})}' +
    'function deletePrompt(b){' +
      'var c=b.closest(\'div[data-prompt-id]\'),i=c.dataset.promptId;' +
      'if(confirm(\'删除此 prompt？此操作不可撤销。\')){' +
        'fetch(\'/api/prompts/delete\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},' +
          'body:JSON.stringify({videoId:_VIDEO_ID,platform:_PLATFORM,promptId:i})}).then(function(r){' +
          'if(r.ok){c.style.transition=\'all .3s ease\';c.style.opacity=\'0\';setTimeout(function(){c.remove()},300)}' +
        '});' +
      '}' +
    '}' +
    'document.addEventListener(\'paste\',function(e){var f=e.clipboardData&&e.clipboardData.files[0];if(f&&_activePromptImageInput)uploadPromptFile(f,_activePromptImageInput.dataset.promptId)});' +
    'document.querySelectorAll(\'div[data-prompt-id]\').forEach(function(card){card.addEventListener(\'dragover\',function(e){e.preventDefault()});card.addEventListener(\'drop\',function(e){e.preventDefault();var f=e.dataTransfer&&e.dataTransfer.files[0];if(f)uploadPromptFile(f,card.dataset.promptId)})});' +
  '</script>');
  h.push("</body></html>");

  return { html: h.join("\n"), coverCount, illCount };
};

// ── main orchestrator ──

export const orchestratePlatformPrompts = async (
  input: PlatformFormatInput & { platform: string; llm: LlmPort; llmModel: string },
): Promise<PlatformFormatResult> => {
  const spec = PLATFORM_SPECS[input.platform];
  if (spec === undefined) throw new Error(`Unsupported platform: ${input.platform}`);

  const articleDir = path.resolve(input.articleDir);
  const outputDir = path.join(articleDir, spec.outputDir);
  await mkdir(outputDir, { recursive: true });

  // read metadata if available
  let title = "";
  let body = input.articleMd;
  try {
    const metaPath = path.join(articleDir, `${input.platform}-format`, `${input.platform}-metadata.json`);
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as { title?: string; body?: string };
    if (meta.title) title = meta.title;
    if (meta.body) body = meta.body;
  } catch { /* use article.md */ }

  if (!title) {
    const match = input.articleMd.match(/^#\s+(.+)$/m);
    title = (match?.[1] ?? "").replace(/\*\*/g, "");
  }

  const sections = splitBodyIntoSections(body, input.platform);
  const files: string[] = [];

  // If prompts.json already exists AND has non-empty illustrationPrompts,
  // reuse cached prompts instead of calling the LLM again. An empty
  // illustrationPrompts array means the previous LLM call returned nothing
  // useful — regenerate rather than caching failure permanently.
  const promptsPath = path.join(outputDir, "prompts.json");
  let coverPrompts: Array<{ label: string; prompt: string; size: string; filename: string; name: string }> = [];
  let illustrationPrompts: Array<{ index: number; text: string; prompt: string; filename: string; name: string }> = [];
  let hasCachedPrompts = false;
  try {
    const cachedRaw = await readFile(promptsPath, "utf8");
    const cached = JSON.parse(cachedRaw) as { coverPrompts: typeof coverPrompts; illustrationPrompts: typeof illustrationPrompts };
    if (Array.isArray(cached.coverPrompts) && Array.isArray(cached.illustrationPrompts)) {
      coverPrompts = cached.coverPrompts;
      illustrationPrompts = cached.illustrationPrompts;
      hasCachedPrompts = true;
    }
  } catch {
    // prompts.json doesn't exist — will generate via LLM below
  }

  if (!hasCachedPrompts) {
  // generate cover prompts
  for (const coverSpec of spec.coverRatios) {
    const slug = title.replace(/[^a-zA-Z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).toLowerCase() || "cover";
    const coverFilename = `cover-${slug}.png`;
    const coverName = title.slice(0, 20) || "封面";
    const systemPrompt = COVER_SYSTEM_PROMPT;
    const _userPrompt = [
      `Create a cover image prompt for ${coverSpec.label}.`,
      `${coverSpec.description}.`,
      ``,
      `Article title: ${title}`,
      `Platform: ${spec.label}`,
      ``,
      `The cover should capture the OVERALL thesis of the article as a single powerful visual metaphor.`,
      `Not a UI walkthrough. Not a detailed diagram. A cover that makes people want to click.`,
    ].join("\n");

    let prompt = "";
    try {
      const coverUserPrompt = [
        `Create a cover image prompt for ${coverSpec.label}.`,
        `${coverSpec.description}.`,
        ``,
        `Article title: ${title}`,
        `Platform: ${spec.label}`,
        ``,
        `The cover should capture the OVERALL thesis of the article as a single powerful visual metaphor.`,
        ``,
        `ARTICLE TEXT (for context):`,
        body.slice(0, 3000),
      ].join("\n");

      const coverResp = await input.llm.chat({
        model: input.llmModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: coverUserPrompt },
        ],
        temperature: 0.7,
        maxTokens: 4096,
      });
      prompt = (coverResp.content ?? "").trim();
    } catch (err: unknown) {
      process.stderr.write(`cover prompt error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (!prompt) {
      prompt = `Editorial cover illustration. sketch-knowledge-kit style — warm paper, black marker, orange accent. Title: "${title}". ${coverSpec.description}. Clean, minimal, educational.`;
    }
    coverPrompts.push({ label: coverSpec.label, prompt, size: coverSpec.size, filename: coverFilename, name: coverName });
  }

  // Generate illustration prompts: one call with full article.
  // No section splitting. No truncation. LLM reads everything and decides.
  // Reuse the outer illustrationPrompts variable — do NOT shadow with const.
  const imgRefRe2 = /!\[.*?\]\(\.?\/?images\/([^)]+)\)/;
  illustrationPrompts = [];

  try {
    const illUserPrompt = [
      `Read this complete article and create illustration prompts following the sketch-knowledge-kit visual system for ${spec.label}.`,
      ``,
      `Article: ${title}`,
      `Required ratio: ${spec.illustrationRatio}`,
      ``,
      `FULL ARTICLE TEXT:`,
      body,
    ].join("\n");

    const isXhsIll = input.platform === "xiaohongshu";
    const illSystemPrompt = [
      isXhsIll
        ? `Xiaohongshu images are NOTE CARDS, not illustrations. Each 3:4 image is a self-contained knowledge card the reader can study — like a well-designed notebook page.`
        : `Create illustration prompts following sketch-knowledge-kit. Fill EVERY field below with exact Chinese labels. No generic descriptions.`,
      ``,
      isXhsIll
        ? `CRITICAL: NOT a simplified visual metaphor. An INFORMATION-DENSE page with 40-60% handwritten Chinese text. Only 20-30% whitespace. The reader should be able to READ the image.`
        : `For each section you pick, the prompt must fill this exact structure:`,
      ``,
      isXhsIll
        ? `Canvas: 3:4 portrait, 1080x1440px. Section: "[Chinese heading]". This is a Xiaohongshu knowledge card.`
        : `Canvas: ${spec.illustrationRatio}, [exact pixels].`,
      isXhsIll
        ? `LAYOUT (top to bottom): 1. TITLE (top 10-15%): Bold hand-drawn Chinese heading, orange underline. 2. CORE ARGUMENT (15-20%): 2-3 sentences summarizing the thesis. 3. DETAILED CONTENT (40-50%): Numbered steps, before/after comparisons, bullet takeaways, concrete examples — ALL in readable hand-drawn Chinese. Each point a complete thought. 4. BOTTOM BAR (5-10%): Horizontal line + article short title in small script.`
        : `Section: "[Chinese heading]". Mode: [before-after / walkthrough / single-feature / conceptual-diagram].`,
      isXhsIll
        ? `STYLE: #F5F0E8 paper+grain. Black marker for borders/dividers/icons. Orange (#E67E22) ONLY on title underline + 1-2 highlight boxes. ALL text hand-drawn Chinese, varying sizes. Simple hand-drawn icons.`
        : `Scene — every element labeled in Chinese: Left/Center/Right/Arrows with exact "[Chinese]" labels. Orange on 1-2 elements. Labels: heading + 1-3 key terms.`,
      isXhsIll
        ? `Avoid: dark bg, screenshots, glossy UI, 3D, computer fonts, pure white.`
        : `Color: #F5F0E8 paper+grain, black marker, orange only on specified elements. 70%+ whitespace. Avoid: dark bg, screenshots, OS chrome, glossy UI, 3D, gradients, computer fonts, pure white, photos.`,
      ``,
      isXhsIll
        ? `Pick ALL major sections. Default to INCLUDE. Skip only pure tag lists and disclaimers.`
        : `DECISION RULES: Pick sections with comparisons, workflows, architecture, before/after, processes. Skip conclusions, disclaimers, tags, code blocks.`,
      ``,
      isXhsIll
        ? `Every prompt MUST end with: "Aspect ratio: 3:4 portrait (1080x1440 pixels)."`
        : `Every prompt MUST end with: "Aspect ratio: ${spec.illustrationRatio}."`,
      `Return JSON array: [{"index": <1-based N>, "filename": "<slug>.png", "name": "<Chinese description>", "prompt": "<filled template above>"}].`,
      `Return ONLY JSON. No markdown.`,
    ].join("\n");

    const resp = await input.llm.chat({
      model: input.llmModel,
      messages: [
        { role: "system", content: illSystemPrompt },
        { role: "user", content: illUserPrompt },
      ],
      temperature: 0.7,
      maxTokens: 16384,
    });

    const raw = (resp.content ?? "").replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ index: number; prompt: string; filename?: string; name?: string }>;
      for (const item of parsed) {
        const idx = item.index - 1;
        if (idx >= 0 && idx < sections.length && item.prompt?.trim() && !imgRefRe2.test(sections[idx]!)) {
          illustrationPrompts.push({
            index: idx,
            text: sections[idx]!.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 300),
            prompt: item.prompt.trim(),
            filename: item.filename?.trim() || `illus-${String(idx + 1).padStart(2, "0")}.png`,
            name: item.name?.trim() || `插图 ${idx + 1}`,
          });
        }
      }
    }
  } catch (err: unknown) {
    process.stderr.write(`illustration prompt error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  } // end if (!hasCachedPrompts)

  // Post-process: force correct aspect ratio on every prompt
  const illRatioSuffix = spec.illustrationRatio ? ` Aspect ratio: ${spec.illustrationRatio}.` : "";
  for (const il of illustrationPrompts) {
    // Strip any existing aspect-ratio text (LLM may have generated wrong one), then append correct
    il.prompt = il.prompt.replace(/\s*Aspect ratio:.*?\.?\s*$/i, "").trimEnd();
    if (illRatioSuffix) il.prompt += illRatioSuffix;
  }
  for (const cp of coverPrompts) {
    cp.prompt = cp.prompt.replace(/\s*Aspect ratio:.*?\.?\s*$/i, "").trimEnd();
    if (cp.size) cp.prompt += ` Aspect ratio: ${cp.label} (${cp.size}).`;
  }

  // save prompts.json (only if newly generated — cached prompts are already on disk)
  if (!hasCachedPrompts) {
    const promptsData = {
      platform: input.platform,
      title,
      model: input.llmModel,
      coverPrompts,
      illustrationPrompts,
    };
    await writeFile(promptsPath, JSON.stringify(promptsData, null, 2), "utf8");
    files.push(promptsPath);
  }

  // Build prompt lookup: section index → prompt text
  const promptMap = new Map<number, string>();
  const nameMap = new Map<number, string>();
  for (const il of illustrationPrompts) {
    promptMap.set(il.index, il.prompt);
    nameMap.set(il.index, il.name);
  }

  // Render HTML: article sections with inline prompt placeholders
  const platformLabel = { x: "X", wechat: "公众号", xiaohongshu: "小红书", bilibili: "B站" }[input.platform] ?? input.platform;
  const promptActions = function (promptText: string, label: string, sizeHint: string, name?: string) {
    const encoded = _chatGptUrl(promptText);
    const nameHtml = name
      ? '<div class="ph-name">' + _esc(name) + '</div>'
      : '';
    return '<div class="ph-box">' + _esc(promptText) + '</div>' +
      nameHtml +
      '<div class="ph-row"><span class="ph-label">' + label + ' · ' + sizeHint + '</span>' +
      '<span class="ph-btns"><button class="ph-copy" onclick="navigator.clipboard.writeText(atob(this.dataset.promptB64))" data-prompt-b64="' + Buffer.from(promptText, "utf8").toString("base64") + '">📋 复制</button>' +
      '<a class="ph-chatgpt" href="https://chatgpt.com/?q=' + encoded + '" target="_blank">🤖 ChatGPT</a></span></div>';
  };

  // Extract image filenames from markdown sections
  const sectionImages: string[][] = sections.map(function (s) {
    const imgs: string[] = [];
    let m: RegExpExecArray | null;
    const re = /!\[.*?\]\(images\/([^)]+)\)/g;
    while ((m = re.exec(s)) !== null) { imgs.push(m[1]!); }
    return imgs;
  });

  const isXhs2 = input.platform === "xiaohongshu";
  const videoId2 = path.basename(articleDir);
  const platformSubdir2 = input.platform === "x" ? "" : (input.platform === "xiaohongshu" ? "xiaohongshu-format" : input.platform === "wechat" ? "wechat-format" : "bilibili-format");
  const imgUrl2 = function (f: string) { return "/api/file-image?videoId=" + encodeURIComponent(videoId2) + "&file=" + encodeURIComponent(f) + (platformSubdir2 ? "&subdir=" + encodeURIComponent(platformSubdir2) : ""); };

  let sectionBlocks: string;

  if (isXhs2) {
    // ── XHS layout: image gallery (top) + longform article (bottom) ──
    const galleryItems: string[] = [];

    // Cover
    if (coverPrompts.length > 0) {
      const firstSectionImgs = sectionImages[0] ?? [];
      const coverFile = firstSectionImgs.length > 0 ? firstSectionImgs[0]! : null;
      const coverNm = coverPrompts[0]!.name ?? "封面";
      if (coverFile) {
        galleryItems.push('<div class="xhs-slide"><img src="' + imgUrl2(coverFile) + '" alt="封面" class="xhs-slide-img" /><div class="img-label">封面</div></div>');
      } else {
        galleryItems.push('<div class="xhs-slide xhs-slide-placeholder">' + promptActions(coverPrompts[0]!.prompt, '🎨 封面', coverPrompts[0]!.size, coverNm) + '</div>');
      }
    }

    // Section images + prompt placeholders
    const allSectionImgs = new Set<string>();
    for (const imgs of sectionImages) { for (const f of imgs) { allSectionImgs.add(f); } }
    for (let i = 0; i < sections.length; i++) {
      const imgs = sectionImages[i]!;
      for (const f of imgs) {
        galleryItems.push('<div class="xhs-slide"><img src="' + imgUrl2(f) + '" alt="' + f + '" class="xhs-slide-img" /><div class="img-label">' + f + '</div></div>');
      }
      // Prompt placeholder for sections that have a prompt but no image
      const promptText = promptMap.get(i);
      if (promptText && imgs.length === 0) {
        const nm = nameMap.get(i) ?? ('插图 ' + (i + 1));
        galleryItems.push('<div class="xhs-slide xhs-slide-placeholder">' + promptActions(promptText, '📷 3:4 竖版', '3:4', nm) + '</div>');
      }
    }

    // Inject slide counter into each gallery item before closing xhs-slide div
    const totalSlides = galleryItems.length;
    const galleryHtml = totalSlides > 0
      ? '<div class="xhs-gallery"><div class="xhs-gallery-label">📷 图集 · ' + totalSlides + ' 张</div><div class="xhs-gallery-scroll">' + galleryItems.map(function (item, idx) { return item.replace(/<\/div>$/, '<div class="slide-counter">' + (idx + 1) + '/' + totalSlides + '</div></div>'); }).join("") + '</div></div>'
      : "";

    // Article text
    const articleBlocks: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const secText = sections[i]!;
      const clean = secText.replace(/^#+\s*/gm, "").replace(/\*\*/g, "");
      const headingMatch = clean.match(/^(.+?)[：:\n]/);
      const heading = headingMatch ? headingMatch[1]!.slice(0, 40) : "";
      const body = heading ? clean.slice(heading.length).replace(/^[：:\s]+/, "") : clean;
      const headingHtml = heading ? '<h3 class="xhs-sec-heading">' + heading + '</h3>' : "";
      const bodyClean = body
        .replace(/!\[.*?\]\(\.?\/?images\/[^)]+\)/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/\n/g, "<br>");
      const bodyHtml = bodyClean ? '<div class="xhs-sec-body">' + bodyClean + '</div>' : "";
      if (headingHtml || bodyHtml) articleBlocks.push('<div class="xhs-article-block">' + headingHtml + bodyHtml + '</div>');
    }
    const articleHtml = articleBlocks.length > 0
      ? '<div class="xhs-article">' + articleBlocks.join("") + '</div>'
      : "";

    sectionBlocks = galleryHtml + articleHtml;
  } else {
    // ── X / Bilibili / WeChat: inline images per section ──
    let coverHtml = "";
    if (coverPrompts.length > 0) {
      const firstSectionImgs = sectionImages[0] ?? [];
      const coverFile = firstSectionImgs.length > 0 ? firstSectionImgs[0]! : null;
      if (coverFile) {
        coverHtml = '<div class="cover-wrap"><img src="' + imgUrl2(coverFile) + '" alt="封面" class="cover-img" /><div class="img-label">封面</div></div>';
      } else {
        coverHtml = '<div class="cover-wrap">' + promptActions(coverPrompts[0]!.prompt, '封面', coverPrompts[0]!.size) + '</div>';
      }
    }
    let promptCounter2 = 0;
    const totalPrompts2 = (coverHtml ? 1 : 0) + sections.filter(function (_s, i) { return promptMap.has(i); }).length;

    sectionBlocks = (coverHtml ? coverHtml.replace(/<\/div>$/, '<div class="slide-counter">' + (++promptCounter2) + '/' + totalPrompts2 + '</div></div>') : "") + sections.map(function (secText: string, i: number) {
      const promptText = promptMap.get(i);
      const clean = secText.replace(/^#+\s*/gm, "").replace(/\*\*/g, "");
      const headingMatch = clean.match(/^(.+?)[：:\n]/);
      const heading = headingMatch ? headingMatch[1]!.slice(0, 40) : "";
      const body = heading ? clean.slice(heading.length).replace(/^[：:\s]+/, "") : clean;
      const headingHtml = heading ? '<h3 class="sec-heading">' + heading + '</h3>' : "";
      const bodyClean = body
        .replace(/!\[.*?\]\(\.?\/?images\/[^)]+\)/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/\n/g, "<br>");
      const bodyHtml = bodyClean ? '<div class="sec-body">' + bodyClean + '</div>' : "";
      const existingImgs = sectionImages[i]!.map(function (f) {
        return '<img src="' + imgUrl2(f) + '" alt="' + f + '" class="sec-img" /><div class="img-label">' + f + '</div>';
      }).join("");
      const promptHtml = promptText
        ? promptActions(promptText, '📷 插图 ' + (i + 1), '16:9')
        : "";
      let blockHtml2 = '<div class="sec-block">' + headingHtml + '<div class="sec-body">' + bodyHtml + '</div>' + existingImgs + promptHtml + '</div>';
      if (promptHtml) {
        blockHtml2 = blockHtml2.replace(/<\/div>$/, '<div class="slide-counter">' + (++promptCounter2) + '/' + totalPrompts2 + '</div></div>');
      }
      return blockHtml2;
    }).join("");
  }

  const isXhsCss2 = isXhs2
    ? [
      "body{background:#fbf7f0;color:#2c2416}",
      "body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(255,36,66,.03) 0%,transparent 70%);pointer-events:none;z-index:0}",
      ".container{max-width:420px;margin:72px auto 48px;padding:0 16px;position:relative;z-index:1}",
      ".xhs-gallery{margin-bottom:24px}",
      ".xhs-gallery-label{font-family:'Georgia','Noto Serif SC','Songti SC',serif;font-size:11px;color:#b8a99a;margin-bottom:12px;padding:0 4px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:8px}",
      ".xhs-gallery-label::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#d9cbb8,transparent)}",
      ".xhs-gallery-scroll{display:flex;flex-direction:column;gap:12px}",
      ".xhs-slide{background:#fffdf8;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(44,36,22,.06),0 1px 3px rgba(44,36,22,.04);position:relative;transition:transform .2s ease,box-shadow .2s ease}",
      ".xhs-slide:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(44,36,22,.08),0 2px 6px rgba(44,36,22,.05)}",
      ".xhs-slide-placeholder{background:linear-gradient(168deg,#fffdf8 0%,#fdf9f2 40%,#faf4ea 100%);border:2px dashed #e8d5c0;padding:18px 14px 12px}",
      ".xhs-slide-placeholder .ph-box{margin:0;width:100%;aspect-ratio:3/4;max-height:none;border-color:#e8d5c0;background:rgba(255,252,247,.7);overflow-y:auto;padding:12px 12px;font-size:11px;line-height:1.55}",
      ".xhs-slide-img{width:100%;display:block}",
      ".xhs-article{background:#fffdf8;border-radius:14px;padding:28px 20px;box-shadow:0 4px 24px rgba(44,36,22,.06),0 1px 3px rgba(44,36,22,.04);line-height:1.95;position:relative}",
      ".xhs-article::before{content:'';position:absolute;top:0;left:20px;right:20px;height:3px;background:linear-gradient(90deg,#ff2442,#ff6b81,#ff2442);border-radius:0 0 3px 3px;opacity:.7}",
      ".xhs-article-block+.xhs-article-block{margin-top:32px}",
      ".xhs-sec-heading{font-family:'Georgia','Noto Serif SC','Songti SC',serif;font-size:17px;font-weight:700;color:#1a1008;margin-bottom:10px;letter-spacing:.01em;position:relative;padding-left:12px}",
      ".xhs-sec-heading::before{content:'';position:absolute;left:0;top:4px;bottom:4px;width:3px;background:#ff2442;border-radius:2px}",
      ".xhs-sec-body{font-size:14px;color:#4a3f33;letter-spacing:.01em}",
      ".xhs-sec-body p{margin-bottom:14px}",
      ".xhs-sec-body b,.xhs-sec-body strong{color:#1a1008;font-weight:650}",
      ".sec-heading{font-family:'Georgia','Noto Serif SC',serif;font-size:17px;font-weight:700;color:#1a1008;margin-bottom:10px}",
      ".sec-body{font-size:14px;line-height:1.95;color:#4a3f33}",
      ".sec-body p{margin-bottom:14px}",
      ".sec-img{max-width:100%;height:auto;display:block}",
      ".cover-img{max-width:100%;height:auto;display:block}",
      ".img-label{padding:8px 14px;font-size:10px;color:#b8a99a;text-align:right;background:linear-gradient(180deg,rgba(255,252,247,0),#faf4ea);font-family:'Georgia',serif;letter-spacing:.03em}",
    ].join("")
    : [
      "body{background:#f5f5f5}",
      ".container{max-width:680px;margin:64px auto 40px;padding:0 16px}",
      ".article-body{background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);line-height:1.9}",
      ".sec-block+.sec-block{margin-top:28px}",
      ".sec-heading{font-size:16px;font-weight:700;color:#111;margin-bottom:8px}",
      ".sec-body{font-size:14px;line-height:1.9;color:#444}",
      ".sec-body p{margin-bottom:12px}",
      ".sec-img{max-width:100%;height:auto;display:block;margin:12px 0}",
      ".cover-wrap{background:#fff;border-radius:8px;overflow:hidden;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}",
      ".cover-img{max-width:100%;height:auto;display:block}",
      ".img-label{padding:6px 12px;font-size:11px;color:#bbb;text-align:right;background:#fafafa}",
    ].join("");

  const h2: string[] = [];
  h2.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
  h2.push("<title>" + title + " - " + platformLabel + " 编排</title>");
  h2.push("<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#333}");
  h2.push(".toolbar{position:fixed;top:0;left:0;right:0;background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-bottom:1px solid #e0e0e0;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:100}");
  h2.push(".toolbar h2{font-size:15px;color:#333;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar span{font-size:12px;color:#999}");
  h2.push(isXhsCss2);
  h2.push(".ph-box{background:linear-gradient(165deg,#fffdf8,#fdf9f2);border:2px dashed #e8d5c0;padding:18px 16px;font-size:12px;color:#6b5e4f;line-height:1.7;white-space:pre-wrap;max-height:200px;overflow-y:auto;border-radius:8px}");
  h2.push(".ph-name{font-size:14px;color:#1a1008;font-weight:700;padding:10px 14px 0;text-align:center;letter-spacing:.02em}");
  h2.push(".slide-counter{font-size:10px;color:#999;font-family:'Georgia',serif;opacity:.6;text-align:right;padding:4px 12px 0}");
  h2.push(".ph-row{display:flex;align-items:center;justify-content:space-between;padding:6px 14px 4px}");
  h2.push(".ph-label{font-size:10px;color:#b8a99a;font-family:'SF Mono','ui-monospace',monospace;letter-spacing:.03em}");
  h2.push(".ph-btns{display:flex;gap:8px}");
  h2.push(".ph-copy,.ph-chatgpt{padding:4px 12px;font-size:11px;border-radius:6px;cursor:pointer;text-decoration:none;display:inline-block;font-weight:600;transition:all .15s ease}");
  h2.push(".ph-copy{border:1px solid #d9cbb8;background:#fffdf8;color:#6b5e4f}.ph-copy:hover{background:#faf4ea;border-color:#c4a98a}");
  h2.push(".ph-chatgpt{background:#ff2442;border:1px solid #ff2442;color:#fff}.ph-chatgpt:hover{background:#e01e38;border-color:#e01e38;box-shadow:0 2px 8px rgba(255,36,66,.25)}");
  h2.push(".ph-edit-ta{width:100%;min-height:100px;padding:10px;font-size:12px;line-height:1.6;border:2px solid #E07030;border-radius:6px;font-family:monospace;resize:vertical;box-sizing:border-box;background:#fffdf8;color:#333}");
  h2.push(".ph-edit-btn,.ph-del-btn{padding:2px 7px;font-size:13px;border-radius:4px;cursor:pointer;border:1px solid #ddd;background:#fff;line-height:1.4;transition:all .15s ease}");
  h2.push(".ph-edit-btn:hover{background:#f0f0f0}.ph-del-btn{color:#c0392b;border-color:#f5c6cb}.ph-del-btn:hover{background:#fde8e8}");
  h2.push(".copy-bar{text-align:center;padding:16px}.copy-bar button{padding:10px 24px;border:2px solid #E07030;background:#fff;color:#E07030;border-radius:8px;cursor:pointer;font-weight:600}</style></head>");
  h2.push("<body><div class='toolbar'><h2>" + title + "</h2><span>" + platformLabel + (isXhs2 ? " · 图集+" + illustrationPrompts.length + "图/" + sections.length + "节" : " · " + illustrationPrompts.length + "图/" + sections.length + "节") + "</span></div>");
  h2.push('<div class="container"><div class="note" style="background:#fff;border-radius:8px;padding:14px 20px;margin-bottom:16px;font-size:13px;color:#888;line-height:1.6">');
  h2.push(isXhs2 ? '📌 上图集 + 下正文。虚线框为待生成图片的 3:4 prompt 占位，适合小红书图集滑动浏览。' : '📌 以下为文章图文编排预览。虚线框为待生成图片的 prompt 占位。');
  h2.push('</div>');
  h2.push(isXhs2 ? sectionBlocks : '<div class="article-body">' + sectionBlocks + '</div>');
  const allPromptsJson = JSON.stringify({ coverPrompts, illustrationPrompts });
  h2.push('<div class="copy-bar"><button onclick="var t=document.getElementById(\'all-prompts-data\').textContent;navigator.clipboard.writeText(t);this.textContent=\'✅ 已复制\';setTimeout(function(){this.textContent=\'📋 复制全部 Prompt JSON\'}.bind(this),2000)">📋 复制全部 Prompt JSON</button>');
  h2.push('<script id="all-prompts-data" type="application/json">' + allPromptsJson.replace(/</g, "\\u003c") + '</script>');
  h2.push("</body></html>");

  const html = h2.join("\n");
  const htmlPath = path.join(outputDir, "orchestrate.html");
  await writeFile(htmlPath, html, "utf8");
  files.push(htmlPath);

  return { outputDir, files, imagesGenerated: 0 };
};
