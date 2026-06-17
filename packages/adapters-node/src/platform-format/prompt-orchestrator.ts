import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmPort } from "@yt2x/core";
import type { PlatformFormatInput, PlatformFormatResult } from "./types.js";

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
    illustrationRatio: "16:9 landscape — X article inline illustrations",
    outputDir: "x-format",
  },
  wechat: {
    label: "WeChat Official Account (微信公众号)",
    coverRatios: [
      { label: "公众号封面 1:1", size: "1024×1024", description: "1:1 square — WeChat primary cover, title centered, bold and thumbnail-friendly" },
      { label: "公众号封面 16:9", size: "1792×1024", description: "16:9 landscape — WeChat share cover, horizontal composition, title centered with side margins" },
    ],
    illustrationRatio: "varies — match the section's natural layout",
    outputDir: "wechat-format",
  },
  xiaohongshu: {
    label: "Xiaohongshu (小红书)",
    coverRatios: [
      { label: "小红书封面 3:4", size: "1080×1440", description: "3:4 portrait/vertical — Xiaohongshu feed cover, eye-catching, title prominent" },
    ],
    illustrationRatio: "3:4 portrait/vertical (1080×1440)",
    outputDir: "xiaohongshu-format",
  },
  bilibili: {
    label: "Bilibili (哔哩哔哩)",
    coverRatios: [
      { label: "B站视频封面 16:9", size: "1920×1080", description: "16:9 landscape — Bilibili video cover, bold title, thumbnail-friendly, high contrast" },
    ],
    illustrationRatio: "varies — timeline keyframe style",
    outputDir: "bilibili-format",
  },
};

// ── LLM prompt generation ──

const callLlm = async (llm: LlmPort, model: string, systemPrompt: string, userPrompt: string): Promise<string> => {
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
  `You are creating cover image-generation prompts following the sketch-knowledge-kit visual system.`,
  ``,
  `Visual identity: Warm paper texture. Black marker/ink linework, hand-drawn quality. Anthropic orange (#E07030) as accent only. Hand-drawn typography. Generous whitespace. Slight scanned feel. Clean, minimal, educational editorial quality.`,
  ``,
  `The cover captures the TOTAL VIEW of the article — a conceptual map, the overarching thesis, designed to be shareable and saved.`,
  `Do NOT create a UI walkthrough or detailed tutorial illustration. The cover is a single powerful visual metaphor.`,
  ``,
  `CRITICAL: Every prompt MUST specify the exact aspect ratio and dimensions.`,
  ``,
  `Output ONLY the English prompt, 150-300 words. No markdown, no JSON.`,
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

const splitBodyIntoSections = (body: string): string[] => {
  // Split only on ## headings (and # title). Don't split on CJK patterns.
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
      <div class="prompt-box">${c.prompt.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
      <div class="card-actions">
        <button class="copy-btn" onclick="copyText(${i})">📋 复制 Prompt</button>
        <a class="chatgpt-btn" href="https://chatgpt.com/?q=${encodeURIComponent(c.prompt)}" target="_blank">🤖 打开 ChatGPT</a>
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
      <div class="card-text">${il.text.replace(/\n/g, "<br>").slice(0, 200)}…</div>
      <div class="prompt-box">${il.prompt.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
      <div class="card-actions">
        <button class="copy-btn" onclick="copyText(${idx})">📋 复制 Prompt</button>
        <a class="chatgpt-btn" href="https://chatgpt.com/?q=${encodeURIComponent(il.prompt)}" target="_blank">🤖 打开 ChatGPT</a>
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
  const imageDir = path.join(articleDir, "images");
  let entries: string[] = [];
  try { entries = await readdir(imageDir); } catch { entries = []; }
  const imageSet = new Set(entries);

  // Read article text
  const articleFiles: Record<string, string> = { x: "article.md", xiaohongshu: "xiaohongshu-article.md", bilibili: "bilibili-article.md", wechat: "article.md" };
  const articleFile = articleFiles[platform] ?? "article.md";
  let articleText = "";
  try { articleText = await rf(path.join(articleDir, articleFile), "utf8"); } catch {
    try { articleText = await rf(path.join(articleDir, "article.md"), "utf8"); } catch { /* no text */ }
  }
  if (!articleText) return null;

  // Parse title
  const titleMatch = articleText.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? "文章预览";
  const articleTitleClean = title.replace(/\*\*/g, "");
  const platformLabel = { x: "X", wechat: "公众号", xiaohongshu: "小红书", bilibili: "B站" }[platform] ?? platform;
  const videoId = path.basename(articleDir);
  const imgUrl = (f: string) => "/api/file-image?videoId=" + encodeURIComponent(videoId) + "&file=" + encodeURIComponent(f);
  const imgExists = (f: string) => imageSet.has(f);
  const imgRefRe = /!\[.*?\]\(images\/([^)]+)\)/;

  // Parse sections by ## headings, tracking image references per section
  const sections: Array<{ heading: string; body: string; images: string[] }> = [];
  let curHeading = "";
  let curBody: string[] = [];
  let curImages: string[] = [];
  let afterTitle = false;
  const lines = articleText.split("\n");
  for (const line of lines) {
    if (/^#\s/.test(line) && !afterTitle) { afterTitle = true; continue; }
    if (/^##\s/.test(line)) {
      if (curBody.length > 0 || curHeading || curImages.length > 0) {
        sections.push({ heading: curHeading, body: curBody.join("\n").trim(), images: [...curImages] });
      }
      curHeading = line.replace(/^##\s+/, "").replace(/\*\*/g, "");
      curBody = []; curImages = [];
    } else if (afterTitle) {
      const m = imgRefRe.exec(line);
      if (m) { curImages.push(m[1]!); } else { curBody.push(line); }
    }
  }
  if (curBody.length > 0 || curHeading || curImages.length > 0) {
    sections.push({ heading: curHeading, body: curBody.join("\n").trim(), images: [...curImages] });
  }

  // First image in article = cover
  const allImgs: string[] = [];
  for (const sec of sections) { for (const img of sec.images) { if (imgExists(img)) allImgs.push(img); } }
  const coverImg = allImgs.length > 0 ? allImgs[0]! : null;
  const usedImgs = new Set<string>(coverImg ? [coverImg] : []);

  // Render: cover then sections with text + inline images
  const isXhs = platform === "xiaohongshu";
  const coverHtml = coverImg
    ? '<div class="cover-wrap"><img src="' + imgUrl(coverImg) + '" alt="封面" class="cover-img" /><div class="img-label">封面</div></div>'
    : "";

  const sectionHtml = sections.map(function (sec, i) {
    const h = sec.heading ? '<h3 class="sec-heading">' + sec.heading + '</h3>' : "";
    const b = sec.body
      ? '<div class="sec-body">' + sec.body.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + '</div>'
      : "";
    const imgs = sec.images.filter(function (f) { return imgExists(f) && !usedImgs.has(f); });
    const imgHtml = imgs.map(function (f) { usedImgs.add(f); return '<img src="' + imgUrl(f) + '" alt="' + f + '" class="sec-img" /><div class="img-label">' + f + '</div>'; }).join("");

    // Show prompt placeholder if section has prompt but no image
    const secPrompt = promptMap?.get(i);
    const promptHtml = (secPrompt && imgs.length === 0)
      ? '<div class="ph-box">' + secPrompt.replace(/</g, "&lt;").slice(0, 200) + '</div>' +
        '<div class="ph-row"><span class="ph-label">📷 待生成</span>' +
        '<span class="ph-btns"><button class="ph-copy" onclick="navigator.clipboard.writeText(this.dataset.prompt)" data-prompt="' + secPrompt.replace(/"/g, "&quot;") + '">📋 复制</button>' +
        '<a class="ph-chatgpt" href="https://chatgpt.com/?q=' + encodeURIComponent(secPrompt) + '" target="_blank">🤖 ChatGPT</a></span></div>'
      : "";
    if (isXhs) {
      return '<div class="section">' + imgHtml + promptHtml + '<div class="sec-content">' + h + b + '</div></div>';
    }
    return '<div class="sec-block">' + h + '<div class="sec-body">' + b + '</div>' + imgHtml + promptHtml + '</div>';
  }).join("");

  // Count covers/illustrations for stats
  const coverCount = coverImg ? 1 : 0;
  const illCount = entries.filter(function (f) { return /\.(png|webp|jpg|jpeg)$/i.test(f) && !/^cover\./i.test(f); }).length;

  // Q6B: Show "请先排版" note when no prompts and no section images (cover alone doesn't count)
  const hasSectionImages = allImgs.length > 1; // > 1 means images beyond just the cover
  const needsFormatNote = !promptMap && !hasSectionImages;

  const isXhsCss = isXhs
    ? "body{background:#f0ebe3}.container{max-width:420px;margin:64px auto 40px;padding:0 12px}.section{background:#fff;border-radius:10px;overflow:hidden;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.06)}.sec-content{padding:16px 18px}.sec-img{width:100%;display:block}"
    : "body{background:#f5f5f5}.container{max-width:680px;margin:64px auto 40px;padding:0 16px}.article-body{background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);line-height:1.9}.sec-block+.sec-block{margin-top:28px}.sec-img{width:100%;display:block;margin:12px 0}";

  const h = [];
  h.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
  h.push("<title>" + articleTitleClean + " - " + platformLabel + "</title>");
  h.push("<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#333}");
  h.push(".toolbar{position:fixed;top:0;left:0;right:0;background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-bottom:1px solid #e0e0e0;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:100}");
  h.push(".toolbar h2{font-size:15px;color:#333;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar span{font-size:12px;color:#999}");
  h.push(isXhsCss);
  h.push(".cover-wrap{background:#fff;border-radius:8px;overflow:hidden;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}.cover-img{width:100%;display:block}");
  h.push(".sec-img{max-width:100%;height:auto;display:block}.cover-img{max-width:100%;height:auto;display:block}.sec-heading{font-size:16px;font-weight:700;color:#111;margin-bottom:8px}");
  h.push(".sec-body{font-size:14px;line-height:1.9;color:#444}.sec-body p{margin-bottom:12px}.sec-body b,.sec-body strong{color:#111}");
  h.push(".img-label{padding:6px 12px;font-size:11px;color:#bbb;text-align:right;background:#fafafa}");
  h.push(".ph-box{background:linear-gradient(135deg,#faf8f3,#f5f1e8);border:2px dashed #e0d8c8;padding:16px 18px;font-size:12px;color:#666;line-height:1.6;white-space:pre-wrap;max-height:160px;overflow-y:auto}");
  h.push(".ph-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#fafafa;border-top:1px solid #f0f0f0}");
  h.push(".ph-label{font-size:11px;color:#999}");
  h.push(".ph-btns{display:flex;gap:6px}");
  h.push(".ph-copy,.ph-chatgpt{padding:3px 10px;font-size:11px;border-radius:4px;cursor:pointer;text-decoration:none;display:inline-block}");
  h.push(".ph-copy{border:1px solid #ddd;background:#fff;color:#666}.ph-copy:hover{background:#f0f0f0}");
  h.push(".ph-chatgpt{border:1px solid #74aa9c;background:#74aa9c;color:#fff}.ph-chatgpt:hover{background:#5c9082}");
  h.push(".note{background:#fff;border-radius:8px;padding:14px 20px;margin-bottom:16px;font-size:13px;color:#888;line-height:1.6}</style></head>");
  h.push("<body><div class='toolbar'><h2>" + articleTitleClean + "</h2><span>" + platformLabel + " · 图文预览</span></div>");
  const noteHtml = needsFormatNote
    ? '<div class="note" style="background:#fff3e0;border:1px solid #E07030;text-align:center;font-size:14px;color:#E07030">📌 尚未排版，请先点击「排版」生成 prompt 和图片占位。</div>'
    : '<div class="note">📌 以下为文章图文预览。封面在上，正文按文章顺序展示，插图按 markdown 位置内联。</div>';
  h.push('<div class="container">' + noteHtml);
  h.push(coverHtml);
  h.push(isXhs ? sectionHtml : '<div class="article-body">' + sectionHtml + '</div>');
  h.push("</div></body></html>");

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
    const metaPath = path.join(articleDir, `${input.platform}-metadata.json`);
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as { title?: string; body?: string };
    if (meta.title) title = meta.title;
    if (meta.body) body = meta.body;
  } catch { /* use article.md */ }

  if (!title) {
    const match = input.articleMd.match(/^#\s+(.+)$/m);
    title = (match?.[1] ?? "").replace(/\*\*/g, "");
  }

  const sections = splitBodyIntoSections(body);
  const files: string[] = [];

  // generate cover prompts
  const coverPrompts: Array<{ label: string; prompt: string; size: string }> = [];
  for (const coverSpec of spec.coverRatios) {
    const systemPrompt = COVER_SYSTEM_PROMPT;
    const userPrompt = [
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
      prompt = await callLlm(input.llm, input.llmModel, systemPrompt, userPrompt);
    } catch { /* empty */ }
    if (!prompt) {
      prompt = `Editorial cover illustration. sketch-knowledge-kit style — warm paper, black marker, orange accent. Title: "${title}". ${coverSpec.description}. Clean, minimal, educational.`;
    }
    coverPrompts.push({ label: coverSpec.label, prompt, size: coverSpec.size });
  }

  // Find which sections already have images in the article markdown
  const imgRefRe2 = /!\[.*?\]\(images\/([^)]+)\)/;
  const sectionHasImage = sections.map((s) => imgRefRe2.test(s));
  const sectionsNeedingPrompts = sections
    .map((s, i) => ({ text: s, index: i }))
    .filter((_, i) => !sectionHasImage[i]);

  // Generate illustration prompts ONLY for sections that don't already have images
  const allSectionsText = sectionsNeedingPrompts
    .map((s) => `[Section ${s.index + 1}] ${s.text.slice(0, 300)}`)
    .join("\n\n---\n\n");

  const illustrationPrompts: Array<{ index: number; text: string; prompt: string }> = [];

  if (sectionsNeedingPrompts.length > 0) {
    const batchUserPrompt = [
      `You are creating illustration prompts for a ${spec.label} article following the sketch-knowledge-kit visual system.`,
      ``,
      `Article topic: ${title}`,
      `Sections needing illustrations: ${sectionsNeedingPrompts.length} (${sectionHasImage.filter(Boolean).length} sections already have images and are skipped)`,
      `Illustration ratio: ${spec.illustrationRatio}`,
      ``,
      `TASK:`,
      `1. Review the sections below.`,
      `2. Decide which sections TRULY need an illustration — default to SKIP. Only pick a section if a visual would significantly improve understanding.`,
      `3. For each picked section, create one English prompt (150-300 words).`,
      `4. Most sections do NOT need illustrations. Err on the side of skipping.`,
      ``,
      `PICK ONLY sections with genuinely visual content: UI screenshots, before/after comparisons, dashboards, config panels, architecture diagrams.`,
      `SKIP everything else: concepts, introductions, conclusions, risk warnings, code blocks, prompt templates, lists, text explanations, usage tips.`,
      ``,
      `Return a JSON array. Each item: {"index": <section number from the list below>, "prompt": "<english prompt>"}.`,
      `Return ONLY the JSON array, no markdown, no explanation.`,
      ``,
      `SECTIONS:`,
      allSectionsText,
    ].join("\n");

    const BATCH_SYSTEM_PROMPT = [
      `You select and create illustration prompts for article sections that need images.`,
      `Visual: sketch-knowledge-kit — warm paper, black marker, orange accent, hand-drawn.`,
      `Be selective: only pick sections with concrete visual content.`,
    ].join("\n");

    try {
      const batchResp = await input.llm.chat({
        model: input.llmModel,
        messages: [
          { role: "system", content: BATCH_SYSTEM_PROMPT },
          { role: "user", content: batchUserPrompt },
        ],
        temperature: 0.7,
        maxTokens: 4096,
      });
      const raw = (batchResp.content ?? "").replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as Array<{ index: number; prompt: string }>;
          for (const item of parsed) {
            const idx = item.index - 1;
            if (idx >= 0 && idx < sections.length && item.prompt && item.prompt.trim()) {
              illustrationPrompts.push({
                index: idx,
                text: sections[idx]!.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 300),
                prompt: item.prompt.trim(),
              });
            }
          }
        } catch (jsonErr: unknown) {
          process.stderr.write("batch illustration JSON parse error: " + (jsonErr instanceof Error ? jsonErr.message : String(jsonErr)) + "\n");
          // Fallback: try to salvage individual prompts from raw text
          const matches = raw.match(/\{[^}]*"index"\s*:\s*(\d+)[^}]*"prompt"\s*:\s*"([^"]*(?:\\.[^"]*)*)"[^}]*\}/g);
          if (matches) {
            for (const m of matches) {
              try {
                const item = JSON.parse(m) as { index: number; prompt: string };
                const idx = item.index - 1;
                if (idx >= 0 && idx < sections.length && item.prompt && item.prompt.trim()) {
                  illustrationPrompts.push({
                    index: idx,
                    text: sections[idx]!.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 300),
                    prompt: item.prompt.trim(),
                  });
                }
              } catch { /* skip malformed item */ }
            }
          }
        }
      }
    } catch (err: unknown) {
      process.stderr.write("batch illustration prompt error: " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  // save prompts.json
  const promptsData = {
    platform: input.platform,
    title,
    coverPrompts,
    illustrationPrompts,
  };
  const promptsPath = path.join(outputDir, "prompts.json");
  await writeFile(promptsPath, JSON.stringify(promptsData, null, 2), "utf8");
  files.push(promptsPath);

  // Build prompt lookup: section index → prompt text
  const promptMap = new Map<number, string>();
  for (const il of illustrationPrompts) { promptMap.set(il.index, il.prompt); }

  // Render HTML: article sections with inline prompt placeholders
  const platformLabel = { x: "X", wechat: "公众号", xiaohongshu: "小红书", bilibili: "B站" }[input.platform] ?? input.platform;
  const promptActions = function (promptText: string, label: string, sizeHint: string) {
    const encoded = encodeURIComponent(promptText);
    return '<div class="ph-box">' + promptText.replace(/</g, "&lt;") + '</div>' +
      '<div class="ph-row"><span class="ph-label">' + label + ' · ' + sizeHint + '</span>' +
      '<span class="ph-btns"><button class="ph-copy" onclick="navigator.clipboard.writeText(this.dataset.prompt)" data-prompt="' + promptText.replace(/"/g, "&quot;").replace(/\n/g, "\\n") + '">📋 复制</button>' +
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
  const imgUrl2 = function (f: string) { return "/api/file-image?videoId=" + encodeURIComponent(videoId2) + "&file=" + encodeURIComponent(f); };

  // Cover: use existing image from markdown if present, otherwise prompt placeholder
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

  const sectionBlocks = sections.map(function (secText: string, i: number) {
    const promptText = promptMap.get(i);
    const clean = secText.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 500);
    const headingMatch = clean.match(/^(.+?)[：:\n]/);
    const heading = headingMatch ? headingMatch[1]!.slice(0, 40) : "";
    const body = heading ? clean.slice(heading.length).replace(/^[：:\s]+/, "") : clean;
    const headingHtml = heading ? '<h3 class="sec-heading">' + heading + '</h3>' : "";
    const bodyClean = body
      .replace(/!\[.*?\]\(images\/[^)]+\)/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\n/g, "<br>");
    const bodyHtml = bodyClean ? '<div class="sec-body">' + bodyClean + '</div>' : "";

    // Existing images from markdown
    const existingImgs = sectionImages[i]!.map(function (f) {
      return '<img src="' + imgUrl2(f) + '" alt="' + f + '" class="sec-img" /><div class="img-label">' + f + '</div>';
    }).join("");

    // Prompt placeholder for sections needing one
    const promptHtml = promptText
      ? promptActions(promptText, '📷 插图 ' + (i + 1), isXhs2 ? '3:4' : '16:9')
      : "";

    if (isXhs2) {
      return '<div class="section">' + existingImgs + promptHtml + '<div class="sec-content">' + headingHtml + bodyHtml + '</div></div>';
    }
    return '<div class="sec-block">' + headingHtml + '<div class="sec-body">' + bodyHtml + '</div>' + existingImgs + promptHtml + '</div>';
  }).join("");

  const isXhsCss2 = isXhs2
    ? "body{background:#f0ebe3}.container{max-width:420px;margin:64px auto 40px;padding:0 12px}.section{background:#fff;border-radius:10px;overflow:hidden;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.06)}.sec-content{padding:16px 18px}"
    : "body{background:#f5f5f5}.container{max-width:680px;margin:64px auto 40px;padding:0 16px}.article-body{background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);line-height:1.9}.sec-block+.sec-block{margin-top:28px}";

  const h2: string[] = [];
  h2.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
  h2.push("<title>" + title + " - " + platformLabel + " 编排</title>");
  h2.push("<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#333}");
  h2.push(".toolbar{position:fixed;top:0;left:0;right:0;background:rgba(255,255,255,.95);backdrop-filter:blur(20px);border-bottom:1px solid #e0e0e0;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;z-index:100}");
  h2.push(".toolbar h2{font-size:15px;color:#333;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar span{font-size:12px;color:#999}");
  h2.push(isXhsCss2);
  h2.push(".cover-wrap{background:#fff;border-radius:8px;overflow:hidden;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}");
  h2.push(".sec-img{max-width:100%;height:auto;display:block}.cover-img{max-width:100%;height:auto;display:block}.sec-heading{font-size:16px;font-weight:700;color:#111;margin-bottom:8px}");
  h2.push(".sec-body{font-size:14px;line-height:1.9;color:#444}.sec-body p{margin-bottom:12px}");
  h2.push(".ph-box{background:linear-gradient(135deg,#faf8f3,#f5f1e8);border:2px dashed #e0d8c8;padding:16px 18px;font-size:12px;color:#666;line-height:1.6;white-space:pre-wrap;max-height:160px;overflow-y:auto}");
  h2.push(".ph-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#fafafa;border-top:1px solid #f0f0f0}");
  h2.push(".ph-label{font-size:11px;color:#999}");
  h2.push(".ph-btns{display:flex;gap:6px}");
  h2.push(".ph-copy,.ph-chatgpt{padding:3px 10px;font-size:11px;border-radius:4px;cursor:pointer;text-decoration:none;display:inline-block}");
  h2.push(".ph-copy{border:1px solid #ddd;background:#fff;color:#666}.ph-copy:hover{background:#f0f0f0}");
  h2.push(".ph-chatgpt{border:1px solid #74aa9c;background:#74aa9c;color:#fff}.ph-chatgpt:hover{background:#5c9082}");
  h2.push(".copy-bar{text-align:center;padding:16px}.copy-bar button{padding:10px 24px;border:2px solid #E07030;background:#fff;color:#E07030;border-radius:8px;cursor:pointer;font-weight:600}</style></head>");
  h2.push("<body><div class='toolbar'><h2>" + title + "</h2><span>" + platformLabel + " · " + illustrationPrompts.length + " 图 / " + sections.length + " 节</span></div>");
  h2.push('<div class="container"><div class="note" style="background:#fff;border-radius:8px;padding:14px 20px;margin-bottom:16px;font-size:13px;color:#888;line-height:1.6">📌 以下为文章图文编排预览。虚线框为待生成图片的 prompt 占位。</div>');
  h2.push(coverHtml);
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
