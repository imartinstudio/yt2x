import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmPort } from "@yt2x/core";
import type { PlatformFormatInput, PlatformFormatResult } from "./types.js";

// ── platform-specific spec ──

type PlatformSpec = {
  coverRatios: Array<{ label: string; size: string; description: string }>;
  illustrationRatio: string;
  outputDir: string;
};

const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  x: {
    coverRatios: [
      { label: "X 封面 5:2", size: "1500×600", description: "5:2 landscape — X article cover card, bold visual metaphor, thumbnail-friendly" },
    ],
    illustrationRatio: "16:9 landscape — X article inline illustrations",
    outputDir: "x-format",
  },
  wechat: {
    coverRatios: [
      { label: "公众号封面 1:1", size: "1024×1024", description: "1:1 square — WeChat primary cover, title centered, bold and thumbnail-friendly" },
      { label: "公众号封面 16:9", size: "1792×1024", description: "16:9 landscape — WeChat share cover, horizontal composition, title centered with side margins" },
    ],
    illustrationRatio: "varies — match the section's natural layout",
    outputDir: "wechat-format",
  },
  xiaohongshu: {
    coverRatios: [
      { label: "小红书封面 3:4", size: "1080×1440", description: "3:4 portrait/vertical — Xiaohongshu feed cover, eye-catching, title prominent" },
    ],
    illustrationRatio: "3:4 portrait/vertical (1080×1440)",
    outputDir: "xiaohongshu-format",
  },
  bilibili: {
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

const ILLUSTRATION_SYSTEM_PROMPT = [
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

// ── HTML render ──

const renderPreviewHtml = (
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
    title = match?.[1] ?? "";
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
      `Platform: ${input.platform === "wechat" ? "WeChat Official Account (微信公众号)" : input.platform === "xiaohongshu" ? "Xiaohongshu (小红书)" : "Bilibili (哔哩哔哩)"}`,
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

  // generate illustration prompts
  const illustrationPrompts: Array<{ index: number; text: string; prompt: string }> = [];
  for (let i = 0; i < sections.length; i++) {
    const sectionText = sections[i]!.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").slice(0, 400);

    const userPrompt = [
      `Create a sketch-knowledge-kit illustration prompt for section #${i + 1} of a ${input.platform === "wechat" ? "WeChat" : input.platform === "xiaohongshu" ? "Xiaohongshu" : "Bilibili"} article.`,
      ``,
      `Article topic: ${title}`,
      `Platform illustration ratio: ${spec.illustrationRatio}`,
      ``,
      `Section content:`,
      `${sectionText}`,
    ].join("\n");

    let prompt = "";
    try {
      prompt = await callLlm(input.llm, input.llmModel, ILLUSTRATION_SYSTEM_PROMPT, userPrompt);
    } catch { /* empty */ }

    illustrationPrompts.push({ index: i, text: sectionText, prompt });
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

  // render HTML
  const platformLabel = { x: "X", wechat: "公众号", xiaohongshu: "小红书", bilibili: "B站" }[input.platform] ?? input.platform;
  const html = renderPreviewHtml(title, platformLabel, spec, coverPrompts, illustrationPrompts);
  const htmlPath = path.join(outputDir, "orchestrate.html");
  await writeFile(htmlPath, html, "utf8");
  files.push(htmlPath);

  return { outputDir, files, imagesGenerated: 0 };
};
