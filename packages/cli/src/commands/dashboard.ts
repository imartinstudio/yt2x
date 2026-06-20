import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  formatWechatArticle,
  DEFAULT_WECHAT_FORMAT_THEME,
  formatWechatCovers,
  formatBilibiliText,
  formatXiaohongshuLayout,
  orchestratePlatformPrompts,
  previewExistingArticleImages,
  generatePlatformArticleContent,
  writePlatformArticleBundle,
  createLlmAdapter,
  createImageGeneratorAdapter,
  type LlmFactoryConfig,
  type ImageGeneratorPort,
} from "@yt2x/adapters-node";
import { defaultCliLlmProvider, readLlmApiKeyFromEnv } from "../config/env.js";
import { DASHBOARD_HTML } from "./dashboard-page.js";

type PlatformKey = "x" | "xiaohongshu" | "wechat" | "bilibili";

type PlatformState = {
  published: boolean;
  url: string;
  note: string;
  updatedAt?: string;
  formatStatus?: "formatted" | "failed";
  formatTheme?: string;
  formattedAt?: string;
  htmlPath?: string;
  previewPath?: string;
  formatError?: string;
};

type PublishIndex = {
  videos?: Record<
    string,
    {
      platforms?: Partial<Record<PlatformKey, Partial<PlatformState>>>;
      note?: string;
    }
  >;
};

type DashboardVideo = {
  videoId: string;
  title: string;
  originalTitle: string | null;
  originalDate: string | null;
  uploadDate: string | null;
  updatedAt: string | null;
  articleDir: string | null;
  downloadDir: string | null;
  platforms: Record<
    PlatformKey,
    {
      status: "empty" | "draft" | "formatted" | "published" | "failed";
      generated: boolean;
      published: boolean;
      url: string;
      note: string;
      files: string[];
      formatStatus: "none" | "formatted" | "failed";
      formatTheme: string;
      formattedAt: string | null;
      htmlPath: string;
      previewPath: string;
      formatError: string;
    }
  >;
};

type DashboardPayload = {
  generatedAt: string;
  articleOutDir: string;
  downloadsDir: string;
  indexPath: string;
  videos: DashboardVideo[];
};

const PLATFORMS: Array<{ key: PlatformKey; label: string; primaryFile: string; files: string[] }> = [
  { key: "x", label: "X", primaryFile: "x-format/x-article.md", files: ["x-format/x-article.md", "x-format/x-short.md", "x-format/x-thread.md", "x-format/x-video-short.md"] },
  { key: "xiaohongshu", label: "小红书", primaryFile: "xiaohongshu-format/xiaohongshu-article.md", files: ["xiaohongshu-format/xiaohongshu-article.md"] },
  { key: "wechat", label: "公众号", primaryFile: "wechat-format/wechat-article.md", files: ["wechat-format/wechat-article.md"] },
  { key: "bilibili", label: "B站", primaryFile: "bilibili-format/video-info.md", files: ["bilibili-format/video-info.md"] },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (filePath: string): Promise<unknown> => {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
};

const readPublishIndex = async (indexPath: string): Promise<PublishIndex> => {
  try {
    const parsed = await readJson(indexPath);
    return isRecord(parsed) ? (parsed as PublishIndex) : {};
  } catch {
    return {};
  }
};

const writePublishIndex = async (indexPath: string, index: PublishIndex): Promise<void> => {
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
};

const listChildDirs = async (root: string): Promise<string[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
};

const wechatFormatPaths = (articleDir: string): { formattedDir: string; htmlPath: string; previewPath: string } => {
  const formattedDir = path.join(articleDir, "wechat-format", "article");
  return {
    formattedDir,
    htmlPath: path.join(formattedDir, "article.html"),
    previewPath: path.join(formattedDir, "preview.html"),
  };
};

const newestMtime = async (dir: string | null): Promise<string | null> => {
  if (dir === null) return null;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let newest = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const s = await stat(path.join(dir, entry.name));
      newest = Math.max(newest, s.mtimeMs);
    }
    return newest > 0 ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
};

const titleFromMetadata = async (downloadDir: string | null): Promise<string | undefined> => {
  if (downloadDir === null) return undefined;
  try {
    const meta = await readJson(path.join(downloadDir, "metadata.json"));
    if (!isRecord(meta)) return undefined;
    for (const key of ["title", "fulltitle", "original_title"]) {
      const value = meta[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const stripMarkdownTitle = (title: string): string =>
  title
    .replace(/^\s*#+\s+/u, "")
    .replace(/\*\*/gu, "")
    .trim();

/** Copy article.md → platform article, stripping embedded images and empty image lines. */
const copyArticleWithoutImages = async (src: string, dst: string): Promise<void> => {
  let content = await readFile(src, "utf8");
  // Remove markdown image references: ![alt](images/file)
  content = content.replace(/!\[.*?\]\(\.?\/?images\/[^)]+\)\n?/g, "");
  // Remove leftover blank lines that were only holding an image
  content = content.replace(/\n{3,}/g, "\n\n");
  await mkdir(path.dirname(dst), { recursive: true });
  await writeFile(dst, content, "utf8");
};

const titleFromArticle = async (articleDir: string | null): Promise<string | undefined> => {
  if (articleDir === null) return undefined;
  try {
    const articleMd = await readFile(path.join(articleDir, "article.md"), "utf8");
    const match = articleMd.match(/^#\s+(.+)$/m);
    const title = match?.[1] !== undefined ? stripMarkdownTitle(match[1]) : undefined;
    return title !== undefined && title.length > 0 ? title : undefined;
  } catch {
    return undefined;
  }
};

export const scanDashboardVideos = async (input: {
  articleOutDir: string;
  downloadsDir: string;
  indexPath: string;
}): Promise<DashboardPayload> => {
  const articleOutDir = path.resolve(input.articleOutDir);
  const downloadsDir = path.resolve(input.downloadsDir);
  const indexPath = path.resolve(input.indexPath);
  const index = await readPublishIndex(indexPath);
  const ids = new Set<string>([
    ...(await listChildDirs(articleOutDir)),
    ...(await listChildDirs(downloadsDir)),
    ...Object.keys(index.videos ?? {}),
  ]);

  const videos: DashboardVideo[] = [];
  for (const videoId of [...ids].sort()) {
    const articleDir = path.join(articleOutDir, videoId);
    const downloadDir = path.join(downloadsDir, videoId);
    const hasArticleDir = await stat(articleDir).then((s) => s.isDirectory(), () => false);
    const hasDownloadDir = await stat(downloadDir).then((s) => s.isDirectory(), () => false);
    const originalTitle = (await titleFromMetadata(hasDownloadDir ? downloadDir : null)) ?? null;
    const title = (await titleFromArticle(hasArticleDir ? articleDir : null)) ?? originalTitle ?? videoId;
    const saved = index.videos?.[videoId]?.platforms ?? {};
    const platforms = {} as DashboardVideo["platforms"];

    for (const platform of PLATFORMS) {
      const files: string[] = [];
      for (const file of platform.files) {
        if (hasArticleDir && (await fileExists(path.join(articleDir, file)))) files.push(file);
      }
      const state = saved[platform.key] ?? {};
      const published = state.published === true;
      const formatPaths = platform.key === "wechat" && hasArticleDir ? wechatFormatPaths(articleDir) : null;
      const hasFormattedWechat = formatPaths !== null
        && (await fileExists(formatPaths.htmlPath))
        && (await fileExists(formatPaths.previewPath));
      const generated = files.length > 0 || published || hasFormattedWechat;
      const fmtStatus: "none" | "formatted" | "failed" = state.formatStatus === "failed"
        ? "failed"
        : state.formatStatus === "formatted" || hasFormattedWechat
          ? "formatted"
          : "none";
      // Derive unified status: failed > published > formatted > draft > empty
      // failed takes priority so formatting errors are never hidden by a stale published flag
      let pstatus: "empty" | "draft" | "formatted" | "published" | "failed" = "empty";
      if (fmtStatus === "failed") pstatus = "failed";
      else if (published) pstatus = "published";
      else if (fmtStatus === "formatted") pstatus = "formatted";
      else if (generated) pstatus = "draft";

      platforms[platform.key] = {
        status: pstatus,
        generated,
        published,
        url: typeof state.url === "string" ? state.url : "",
        note: typeof state.note === "string" ? state.note : "",
        files,
        formatStatus: fmtStatus,
        formatTheme: typeof state.formatTheme === "string" ? state.formatTheme : "",
        formattedAt: typeof state.formattedAt === "string" ? state.formattedAt : null,
        htmlPath: typeof state.htmlPath === "string" ? state.htmlPath : formatPaths?.htmlPath ?? "",
        previewPath: typeof state.previewPath === "string" ? state.previewPath : formatPaths?.previewPath ?? "",
        formatError: typeof state.formatError === "string" ? state.formatError : "",
      };
    }

    const updatedAt = [await newestMtime(hasArticleDir ? articleDir : null), await newestMtime(hasDownloadDir ? downloadDir : null)]
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;

    // Read download time: use download dir creation time (birthtime on macOS, ctime elsewhere)
    let originalDate: string | null = null;
    let uploadDate: string | null = null;
    if (hasDownloadDir) {
      try {
        const s = await stat(downloadDir);
        const ts = s.birthtimeMs ?? s.ctimeMs;
        originalDate = new Date(ts).toISOString();
      } catch { /* no stat */ }
      // Read upload_date from metadata (format: YYYYMMDD)
      try {
        const meta = await readJson(path.join(downloadDir, "metadata.json"));
        if (isRecord(meta) && typeof meta["upload_date"] === "string") {
          const d = meta["upload_date"].trim();
          if (/^\d{8}$/.test(d)) {
            uploadDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
          }
        }
      } catch { /* no metadata */ }
    }

    videos.push({
      videoId,
      title,
      originalTitle: originalTitle !== null && originalTitle !== title ? originalTitle : null,
      originalDate,
      uploadDate,
      updatedAt,
      articleDir: hasArticleDir ? articleDir : null,
      downloadDir: hasDownloadDir ? downloadDir : null,
      platforms,
    });
  }

  videos.sort((a, b) => (b.originalDate ?? b.updatedAt ?? "").localeCompare(a.originalDate ?? a.updatedAt ?? ""));
  return { generatedAt: new Date().toISOString(), articleOutDir, downloadsDir, indexPath, videos };
};

const sendJson = (res: ServerResponse, statusCode: number, value: unknown): void => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
};

const sendText = (res: ServerResponse, statusCode: number, value: string, contentType = "text/plain; charset=utf-8"): void => {
  res.writeHead(statusCode, { "content-type": contentType });
  res.end(value);
};

const readBody = async (req: IncomingMessage): Promise<string> =>
  await new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const updatePlatformStatus = async (
  indexPath: string,
  input: { videoId: string; platform: PlatformKey; published: boolean; url?: string; note?: string },
): Promise<void> => {
  const index = await readPublishIndex(indexPath);
  index.videos ??= {};
  index.videos[input.videoId] ??= {};
  index.videos[input.videoId]!.platforms ??= {};
  const prev = index.videos[input.videoId]!.platforms![input.platform] ?? {};
  index.videos[input.videoId]!.platforms![input.platform] = {
    ...prev,
    published: input.published,
    url: input.url ?? (typeof prev.url === "string" ? prev.url : ""),
    note: input.note ?? (typeof prev.note === "string" ? prev.note : ""),
    updatedAt: new Date().toISOString(),
  };
  await writePublishIndex(indexPath, index);
};

const updatePlatformFormatStatus = async (
  indexPath: string,
  input: {
    videoId: string;
    platform: PlatformKey;
    status: "formatted" | "failed";
    theme?: string;
    htmlPath?: string;
    previewPath?: string;
    error?: string;
  },
): Promise<void> => {
  const index = await readPublishIndex(indexPath);
  index.videos ??= {};
  index.videos[input.videoId] ??= {};
  index.videos[input.videoId]!.platforms ??= {};
  const current = index.videos[input.videoId]!.platforms![input.platform] ?? {};
  const next: Partial<PlatformState> = {
    ...current,
    formatStatus: input.status,
    formattedAt: new Date().toISOString(),
    formatError: input.error ?? "",
  };
  const formatTheme = input.theme ?? current.formatTheme;
  const htmlPath = input.htmlPath ?? current.htmlPath;
  const previewPath = input.previewPath ?? current.previewPath;
  if (formatTheme !== undefined) next.formatTheme = formatTheme;
  if (htmlPath !== undefined) next.htmlPath = htmlPath;
  if (previewPath !== undefined) next.previewPath = previewPath;
  index.videos[input.videoId]!.platforms![input.platform] = next;
  await writePublishIndex(indexPath, index);
};

const updateWechatFormatStatus = async (
  indexPath: string,
  input: {
    videoId: string;
    status: "formatted" | "failed";
    theme?: string;
    htmlPath?: string;
    previewPath?: string;
    error?: string;
  },
): Promise<void> => updatePlatformFormatStatus(indexPath, { ...input, platform: "wechat" });

const formatWechatForDashboard = async (
  opts: { articleOutDir: string; indexPath: string; wechatFormatterDir?: string },
  input: { videoId: string; theme: string },
): Promise<{ theme: string; htmlPath: string; previewPath: string }> => {
  const articleDir = path.join(path.resolve(opts.articleOutDir), input.videoId);
  const articlePath = path.join(articleDir, "article.md");

  // Strip markdown images and escape leading # in hashtag lines so the formatter doesn't
  // treat them as markdown headings. The cover image from article.md should NOT appear
  // in the formatted WeChat output.
  let originalMarkdown = "";
  let patched = false;
  try {
    originalMarkdown = await readFile(articlePath, "utf8");
    const modified = originalMarkdown
      .replace(/!\[.*?\]\(\.?\/?images\/[^)]+\)\n?/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^(#[^\s#*_\n])/gm, "\\$1");
    if (modified !== originalMarkdown) {
      await writeFile(articlePath, modified, "utf8");
      patched = true;
    }
  } catch {
    // if we can't read/write, proceed anyway — the formatter will report the error
  }

  try {
    const result = await formatWechatArticle({
      articleDir,
      sourceFile: "article.md",
      theme: input.theme,
      ...(opts.wechatFormatterDir !== undefined ? { formatterDir: opts.wechatFormatterDir } : {}),
    });
    // Validate formatter produced output files
    if (!(await fileExists(result.articleHtmlPath)) || !(await fileExists(result.previewHtmlPath))) {
      throw new Error("排版完成但输出文件不存在: " + result.articleHtmlPath);
    }
    // Create stripped copy for preview (no cover image)
    try { await copyArticleWithoutImages(articlePath, path.join(articleDir, "wechat-format", "wechat-article.md")); } catch { /* best-effort */ }
    await updateWechatFormatStatus(path.resolve(opts.indexPath), {
      videoId: input.videoId,
      status: "formatted",
      theme: result.theme,
      htmlPath: result.articleHtmlPath,
      previewPath: result.previewHtmlPath,
    });
    return {
      theme: result.theme,
      htmlPath: result.articleHtmlPath,
      previewPath: result.previewHtmlPath,
    };
  } finally {
    // restore original markdown
    if (patched && originalMarkdown.length > 0) {
      try {
        await writeFile(articlePath, originalMarkdown, "utf8");
      } catch {
        // best effort
      }
    }
  }
};

type WechatTheme = {
  id: string;
  name: string;
  description: string;
};

const listWechatThemes = async (formatterDir: string | undefined): Promise<WechatTheme[]> => {
  if (formatterDir === undefined || formatterDir.trim().length === 0) {
    return [{ id: DEFAULT_WECHAT_FORMAT_THEME, name: "GitHub", description: "Default GitHub-inspired WeChat formatting theme." }];
  }
  const themesDir = path.join(path.resolve(formatterDir), "themes");
  const entries = await readdir(themesDir, { withFileTypes: true });
  const themes: WechatTheme[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    try {
      const parsed = await readJson(path.join(themesDir, entry.name));
      themes.push({
        id,
        name: isRecord(parsed) && typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : id,
        description: isRecord(parsed) && typeof parsed.description === "string" ? parsed.description.trim() : "",
      });
    } catch {
      themes.push({ id, name: id, description: "" });
    }
  }
  themes.sort((a, b) => a.id.localeCompare(b.id));
  return themes.length > 0 ? themes : [{ id: DEFAULT_WECHAT_FORMAT_THEME, name: "GitHub", description: "" }];
};

const platformFromString = (value: string | null): PlatformKey | null => {
  if (value === "x" || value === "xiaohongshu" || value === "wechat" || value === "bilibili") return value;
  return null;
};

const isSafeVideoId = (value: string): boolean =>
  value.length > 0 && !value.includes("/") && !value.includes("\\");

const fileForPlatform = (platform: PlatformKey): string =>
  PLATFORMS.find((item) => item.key === platform)?.primaryFile ?? "article.md";

const handleDashboardRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  opts: { articleOutDir: string; downloadsDir: string; indexPath: string; wechatFormatterDir?: string; imageGenerator?: ImageGeneratorPort },
): Promise<void> => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    sendText(res, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/videos") {
    sendJson(res, 200, await scanDashboardVideos(opts));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    const videoId = url.searchParams.get("videoId");
    const platform = platformFromString(url.searchParams.get("platform"));
    if (videoId === null || platform === null || !isSafeVideoId(videoId)) {
      sendJson(res, 400, { error: "Invalid videoId or platform." });
      return;
    }
    const filePath = path.join(path.resolve(opts.articleOutDir), videoId, fileForPlatform(platform));
    try {
      sendText(res, 200, await readFile(filePath, "utf8"), "text/markdown; charset=utf-8");
    } catch {
      sendJson(res, 404, { error: "Article file not found." });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat-format/file") {
    const videoId = url.searchParams.get("videoId");
    const kind = url.searchParams.get("kind");
    if (videoId === null || !isSafeVideoId(videoId) || (kind !== "html" && kind !== "preview")) {
      sendJson(res, 400, { error: "Invalid videoId or kind." });
      return;
    }
    const paths = wechatFormatPaths(path.join(path.resolve(opts.articleOutDir), videoId));
    const filePath = kind === "html" ? paths.htmlPath : paths.previewPath;
    try {
      let html = await readFile(filePath, "utf8");

      // Inject prompt placeholders if prompts.json exists (no images → generated prompts)
      const promptsPath = path.join(path.dirname(filePath), "..", "prompts.json");
      try {
        const promptsRaw = await readFile(promptsPath, "utf8");
        const prompts = JSON.parse(promptsRaw) as {
          coverPrompts?: Array<{ prompt: string; label?: string; size?: string }>;
          illustrationPrompts?: Array<{ index: number; name?: string; prompt: string }>;
        };
        const coverCards = (prompts.coverPrompts ?? []).map(function (cp, _i) {
          return '<div class="wx-prompt-card"><div class="wx-prompt-label">🎨 封面' + (cp.label ? ' · ' + cp.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : '') + '</div><div class="wx-prompt-box">' + cp.prompt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</div><div class="wx-prompt-actions"><button onclick="navigator.clipboard.writeText(decodeURIComponent(this.dataset.p))" data-p="' + encodeURIComponent(cp.prompt) + '">📋 复制</button><a href="https://chatgpt.com/?q=' + encodeURIComponent(cp.prompt).slice(0, 1500) + '" target="_blank">🤖 ChatGPT</a></div></div>';
        }).join("");
        const illCards = (prompts.illustrationPrompts ?? []).map(function (ip, i) {
          return '<div class="wx-prompt-card"><div class="wx-prompt-label">📷 ' + (ip.name ? ip.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : '插图 ' + (i + 1)) + '</div><div class="wx-prompt-box">' + ip.prompt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</div><div class="wx-prompt-actions"><button onclick="navigator.clipboard.writeText(decodeURIComponent(this.dataset.p))" data-p="' + encodeURIComponent(ip.prompt) + '">📋 复制</button><a href="https://chatgpt.com/?q=' + encodeURIComponent(ip.prompt).slice(0, 1500) + '" target="_blank">🤖 ChatGPT</a></div></div>';
        }).join("");
        if (coverCards || illCards) {
          const promptsBar = '<div id="wx-prompts-bar"><div class="wx-prompts-header">📌 图片生成 Prompt（' + ((prompts.coverPrompts?.length ?? 0) + (prompts.illustrationPrompts?.length ?? 0)) + ' 张）</div><div class="wx-prompts-grid">' + coverCards + illCards + '</div></div><style>#wx-prompts-bar{background:#fffdf8;border:2px dashed #e8d5c0;border-radius:10px;padding:16px;margin:16px 0;font-family:-apple-system,sans-serif}.wx-prompts-header{font-size:14px;font-weight:700;color:#1a1008;margin-bottom:12px}.wx-prompts-grid{display:flex;flex-direction:column;gap:10px}.wx-prompt-card{background:#faf7f2;border-radius:8px;padding:12px}.wx-prompt-label{font-size:12px;font-weight:600;color:#555;margin-bottom:6px}.wx-prompt-box{font-size:11px;color:#666;line-height:1.6;max-height:120px;overflow-y:auto;white-space:pre-wrap;background:#fff;border:1px solid #eee;padding:8px;border-radius:4px;margin-bottom:6px}.wx-prompt-actions{display:flex;gap:6px}.wx-prompt-actions button,.wx-prompt-actions a{font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;text-decoration:none;border:1px solid #ddd;background:#fff;color:#555}.wx-prompt-actions a{background:#ff2442;color:#fff;border-color:#ff2442}</style>';
          html = html.replace("<body", "<body>\n" + promptsBar);
        }
      } catch { /* no prompts.json */ }

      if (kind === "preview") {
        // preview: rewrite to API endpoint for local browser viewing
        const imageBase = "/api/wechat-format/image?videoId=" + encodeURIComponent(videoId) + "&file=";
        html = html.replace(/src="images\/([^"]+)"/g, (_match: string, file: string) => 'src="' + imageBase + encodeURIComponent(file) + '"');
      } else {
        // article.html: inline images as base64 so WeChat editor displays them on paste
        const imageDir = path.join(path.resolve(opts.articleOutDir), videoId, "wechat-format", "article", "images");
        const imgRegex = /src="images\/([^"]+)"/g;
        const replacements: Array<{ match: string; file: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = imgRegex.exec(html)) !== null) {
          replacements.push({ match: m[0], file: m[1]! });
        }
        for (const { match, file } of replacements) {
          try {
            const imgPath = path.join(imageDir, file);
            // validate path stays inside imageDir
            if (!path.resolve(imgPath).startsWith(path.resolve(imageDir) + path.sep)) continue;
            const data = await readFile(imgPath);
            const ext = path.extname(file).toLowerCase();
            const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
            const mime = mimeTypes[ext] ?? "image/png";
            const dataUri = "data:" + mime + ";base64," + data.toString("base64");
            html = html.replace(match, 'src="' + dataUri + '"');
          } catch {
            // image not found — leave original path unchanged
          }
        }
      }
      sendText(res, 200, html, "text/html; charset=utf-8");
    } catch {
      sendJson(res, 404, { error: "WeChat formatted file not found." });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat-format/image") {
    const videoId = url.searchParams.get("videoId");
    const file = url.searchParams.get("file");
    if (videoId === null || !isSafeVideoId(videoId) || file === null || file.length === 0) {
      sendJson(res, 400, { error: "Invalid videoId or file." });
      return;
    }
    // prevent path traversal
    if (file.includes("/") || file.includes("\\") || file.includes("..")) {
      sendJson(res, 400, { error: "Invalid file name." });
      return;
    }
    const imageDir = path.join(path.resolve(opts.articleOutDir), videoId, "wechat-format", "article", "images");
    const imagePath = path.join(imageDir, file);
    // ensure resolved path stays inside imageDir
    if (!path.resolve(imagePath).startsWith(path.resolve(imageDir) + path.sep)) {
      sendJson(res, 400, { error: "Invalid file path." });
      return;
    }

    try {
      const ext = path.extname(file).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".bmp": "image/bmp",
      };
      const contentType = mimeTypes[ext] ?? "application/octet-stream";
      const data = await readFile(imagePath);
      res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Image not found." });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat-themes") {
    try {
      sendJson(res, 200, { themes: await listWechatThemes(opts.wechatFormatterDir ?? process.env["WECHAT_FORMATTER_DIR"]) });
    } catch (err: unknown) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/wechat-format") {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return;
    }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const theme = typeof parsed.theme === "string" && parsed.theme.trim().length > 0 ? parsed.theme.trim() : DEFAULT_WECHAT_FORMAT_THEME;
    if (!isSafeVideoId(videoId)) {
      sendJson(res, 400, { error: "Invalid videoId." });
      return;
    }
        // Generate WeChat prompts (blocking, consistent with X/XHS behavior)
    const wArticleDir = path.join(path.resolve(opts.articleOutDir), videoId);
    try {
      const wMd = await readFile(path.join(wArticleDir, "article.md"), "utf8");
      if (wMd) {
        let wp = defaultCliLlmProvider();
        let wk = readLlmApiKeyFromEnv(wp);
        const wBaseUrlMap = { openai: "https://api.openai.com/v1", deepseek: "https://api.deepseek.com/v1", moonshot: "https://api.moonshot.cn/v1", anthropic: "https://api.deepseek.com/anthropic" };
        const wModelMap = { openai: "gpt-4o-mini", deepseek: "deepseek-v4-pro", moonshot: "moonshot-v1-8k", anthropic: "deepseek-v4-pro[1m]" };
        const wToken = process.env["ANTHROPIC_AUTH_TOKEN"];
        const wUrl = process.env["ANTHROPIC_BASE_URL"];
        if (wToken && wUrl?.includes("deepseek")) { wp = "anthropic"; wk = wToken; }
        if (wk !== undefined) {
          const wCfg = { provider: wp, apiKey: wk, baseUrl: wBaseUrlMap[wp] ?? "https://api.openai.com/v1", defaultModel: wModelMap[wp] ?? "deepseek-v4-pro" };
          orchestratePlatformPrompts({ articleDir: wArticleDir, videoId, articleMd: wMd, platform: "wechat", llm: createLlmAdapter(wCfg), llmModel: wCfg.defaultModel! }).catch(function(){});
        }
      }
    } catch (err: unknown) {
      process.stderr.write(`wechat prompt orchestrate warning: ${err instanceof Error ? err.message : String(err)}
`);
    }
    try {
      const result = await formatWechatForDashboard(opts, { videoId, theme });
      sendJson(res, 200, {
        ok: true,
        theme: result.theme,
        htmlPath: result.htmlPath,
        previewPath: result.previewPath,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await updateWechatFormatStatus(path.resolve(opts.indexPath), {
        videoId,
        status: "failed",
        theme,
        error: message,
      });
      sendJson(res, 500, { error: message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/status") {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return;
    }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    if (!isSafeVideoId(videoId) || platform === null) {
      sendJson(res, 400, { error: "Invalid videoId or platform." });
      return;
    }
    const statusUrl = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (statusUrl && !/^https?:\/\//i.test(statusUrl)) {
      sendJson(res, 400, { error: "发布链接必须以 http:// 或 https:// 开头" });
      return;
    }
    await updatePlatformStatus(path.resolve(opts.indexPath), {
      videoId,
      platform,
      published: parsed.published === true,
      url: statusUrl,
      note: typeof parsed.note === "string" ? parsed.note : "",
    });
    sendJson(res, 200, { ok: true });
    return;
  }
  // ── auto-generate platform article via LLM if missing ──
  const ensurePlatformArticle = async (videoId: string, targetPlatform: PlatformKey): Promise<string> => {
    if (targetPlatform === "x") return "";
    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);
    const metadataFile = `${targetPlatform}-format/${targetPlatform}-metadata.json`;
    const articleFile = `${targetPlatform}-format/${targetPlatform}-article.md`;

    // already generated? Must have BOTH metadata AND article file
    try {
      await readFile(path.join(articleDir, metadataFile));
      await readFile(path.join(articleDir, articleFile));
      return "";
    } catch {
      // one or both missing — will regenerate below
    }

    const provider = defaultCliLlmProvider();
    const apiKey = readLlmApiKeyFromEnv(provider);
    if (apiKey === undefined) return "no-llm-key";

    const modelMap: Record<string, string> = { openai: "gpt-4o-mini", deepseek: "deepseek-v4-pro", moonshot: "moonshot-v1-8k", anthropic: "claude-sonnet-4-20250514" };
    const baseUrlMap: Record<string, string> = { openai: "https://api.openai.com/v1", deepseek: "https://api.deepseek.com/v1", moonshot: "https://api.moonshot.cn/v1", anthropic: "https://api.anthropic.com/v1" };
    const cfg: LlmFactoryConfig = { provider, apiKey, baseUrl: baseUrlMap[provider] ?? "https://api.openai.com/v1", defaultModel: modelMap[provider] ?? "deepseek-v4-pro" };
    const llm = createLlmAdapter(cfg);
    const model = cfg.defaultModel!;

    let articleMdLocal = "";
    try { articleMdLocal = await readFile(path.join(articleDir, "article.md"), "utf8"); } catch { return "no-article"; }

    const downloadsDir = path.resolve(opts.downloadsDir);
    let meta: { title?: string } = {};
    try { const raw = await readFile(path.join(downloadsDir, videoId, "metadata.json"), "utf8"); meta = JSON.parse(raw) as { title?: string }; } catch { /* ok */ }

    try {
      const result = await generatePlatformArticleContent({
        llm,
        model,
        target: targetPlatform,
        artifacts: { videoDir: path.join(downloadsDir, videoId), videoId, structuredNotesMd: articleMdLocal, metadata: meta as unknown as Record<string, unknown> & { title: string } },
        articleMd: articleMdLocal,
      });
      // Clean up any semi-products before writing fresh files
      try { await rm(path.join(articleDir, metadataFile)); } catch { /* ok if not exists */ }
      try { await rm(path.join(articleDir, articleFile)); } catch { /* ok if not exists */ }
        await writePlatformArticleBundle(path.resolve(opts.articleOutDir), videoId, result.platformArticle);
      return ""; // success
    } catch (err: unknown) {
      return `LLM生成失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // ── platform generate (empty → draft) ──
  if (req.method === "POST" && url.pathname === "/api/platform-generate") {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    if (!isRecord(parsed)) { sendJson(res, 400, { error: "Invalid JSON body." }); return; }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    if (!isSafeVideoId(videoId) || platform === null) { sendJson(res, 400, { error: "Invalid videoId or platform." }); return; }
    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);

    try {
      if (platform === "x" || platform === "wechat") {
        // Copy article.md → platform article, stripping embedded images
        const dstFile = platform === "x" ? "x-format/x-article.md" : "wechat-format/wechat-article.md";
        const src = path.join(articleDir, "article.md");
        const dst = path.join(articleDir, dstFile);
        try { await access(src); } catch { sendJson(res, 400, { error: "article.md 不存在" }); return; }
        await copyArticleWithoutImages(src, dst);
      } else if (platform === "xiaohongshu" || platform === "bilibili") {
        const err = await ensurePlatformArticle(videoId, platform);
        if (err) { sendJson(res, 400, { error: err }); return; }
      }
      sendJson(res, 200, { ok: true, platform });
    } catch (err: unknown) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── platform format dispatch ──
  if (req.method === "POST" && url.pathname === "/api/platform-format") {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return;
    }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    if (!isSafeVideoId(videoId) || platform === null) {
      sendJson(res, 400, { error: "Invalid videoId or platform." });
      return;
    }
    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);
    let articleMd = "";
    try { articleMd = await readFile(path.join(articleDir, "article.md"), "utf8"); } catch { /* empty */ }

    try {
      // auto-generate platform article via LLM if missing
      const genStatus = platform === "xiaohongshu" || platform === "bilibili"
        ? await ensurePlatformArticle(videoId, platform)
        : "";

      // For X and WeChat: ensure platform article file exists by copying article.md
      // article.md is the universal source; each platform gets its own copy.
      const platformArticleFile = platform === "x" ? "x-format/x-article.md"
        : platform === "wechat" ? "wechat-format/wechat-article.md"
        : null;
      if (platformArticleFile !== null) {
        const srcArticle = path.join(articleDir, "article.md");
        const dstArticle = path.join(articleDir, platformArticleFile);
        try {
          await access(dstArticle);
        } catch {
          try {
            // Copy article → platform article, stripping embedded images
            await copyArticleWithoutImages(srcArticle, dstArticle);
          } catch {
            // copy failed — orchestrate can fall back to reading article.md directly
          }
        }
      }

      // X / XHS / WeChat (no images): generate prompts via orchestratePlatformPrompts
      const needsPrompts = platform === "x" || platform === "xiaohongshu";
      if (needsPrompts) {
        // Prefer Anthropic-compatible DeepSeek endpoint (supports [1m] extended thinking)
        let provider = defaultCliLlmProvider();
        let apiKey = readLlmApiKeyFromEnv(provider);
        const baseUrlMap: Record<string, string> = { openai: "https://api.openai.com/v1", deepseek: "https://api.deepseek.com/v1", moonshot: "https://api.moonshot.cn/v1", anthropic: "https://api.deepseek.com/anthropic" };
        const modelMap: Record<string, string> = { openai: "gpt-4o-mini", deepseek: "deepseek-v4-pro", moonshot: "moonshot-v1-8k", anthropic: "deepseek-v4-pro[1m]" };

        // If ANTHROPIC_AUTH_TOKEN is set and points to DeepSeek, use Anthropic protocol
        const anthropicToken = process.env["ANTHROPIC_AUTH_TOKEN"];
        const anthropicUrl = process.env["ANTHROPIC_BASE_URL"];
        if (anthropicToken && anthropicUrl?.includes("deepseek")) {
          provider = "anthropic";
          apiKey = anthropicToken;
        }

        if (apiKey !== undefined) {
          try {
            const cfg: LlmFactoryConfig = { provider, apiKey, baseUrl: baseUrlMap[provider] ?? "https://api.openai.com/v1", defaultModel: modelMap[provider] ?? "deepseek-v4-pro" };
            const llm = createLlmAdapter(cfg);
            await orchestratePlatformPrompts({ articleDir, videoId, articleMd, platform, llm, llmModel: cfg.defaultModel! });
          } catch (err: unknown) {
            process.stderr.write(`orchestrate warning: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      }

      if (platform === "wechat") {
        // Check if article already has images
        const imgRefGlobal = /!\[.*?\]\(\.?\/?images\/([^)]+)\)/g;
        const hasImages = imgRefGlobal.test(articleMd);

        if (hasImages) {
          // Use existing images
          await formatWechatCovers({ articleDir, videoId, articleMd, ...(opts.imageGenerator !== undefined ? { imageGenerator: opts.imageGenerator } : {}) });
        }
        // Always generate prompts for WeChat (for preview prompt cards)
          let provider2 = defaultCliLlmProvider();
          let apiKey2 = readLlmApiKeyFromEnv(provider2);
          const baseUrlMap2: Record<string, string> = { openai: "https://api.openai.com/v1", deepseek: "https://api.deepseek.com/v1", moonshot: "https://api.moonshot.cn/v1", anthropic: "https://api.deepseek.com/anthropic" };
          const modelMap2: Record<string, string> = { openai: "gpt-4o-mini", deepseek: "deepseek-v4-pro", moonshot: "moonshot-v1-8k", anthropic: "deepseek-v4-pro[1m]" };
          const anthropicToken = process.env["ANTHROPIC_AUTH_TOKEN"];
          const anthropicUrl = process.env["ANTHROPIC_BASE_URL"];
          if (anthropicToken && anthropicUrl?.includes("deepseek")) {
            provider2 = "anthropic";
            apiKey2 = anthropicToken;
          }
          if (apiKey2 !== undefined) {
            const cfg: LlmFactoryConfig = { provider: provider2, apiKey: apiKey2, baseUrl: baseUrlMap2[provider2] ?? "https://api.openai.com/v1", defaultModel: modelMap2[provider2] ?? "deepseek-v4-pro" };
            const llm = createLlmAdapter(cfg);
            await orchestratePlatformPrompts({ articleDir, videoId, articleMd, platform: "wechat", llm, llmModel: cfg.defaultModel! });
          }
        const theme = typeof parsed.theme === "string" && parsed.theme.trim().length > 0 ? parsed.theme.trim() : DEFAULT_WECHAT_FORMAT_THEME;
        const fmtResult = await formatWechatForDashboard(opts, { videoId, theme });
        sendJson(res, 200, { ok: true, platform: "wechat", theme: fmtResult.theme });
      } else if (platform === "xiaohongshu") {
        try {
          await formatXiaohongshuLayout({ articleDir, videoId, articleMd });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`xiaohongshu layout error: ${msg}
`);
          await updatePlatformFormatStatus(path.resolve(opts.indexPath), { videoId, platform: "xiaohongshu", status: "failed", error: msg });
          sendJson(res, 500, { error: "小红书排版失败: " + msg });
          return;
        }
        await updatePlatformFormatStatus(path.resolve(opts.indexPath), { videoId, platform: "xiaohongshu", status: "formatted" });
        sendJson(res, 200, { ok: true, platform: "xiaohongshu", ...(genStatus ? { genStatus } : {}) });
      } else if (platform === "bilibili") {
        if (genStatus && genStatus.length > 0) {
          const msg = "B站平台稿生成失败: " + genStatus;
          await updatePlatformFormatStatus(path.resolve(opts.indexPath), { videoId, platform: "bilibili", status: "failed", error: msg });
          sendJson(res, 400, { error: msg });
          return;
        }
        const result = await formatBilibiliText({ articleDir, videoId, articleMd });
        await updatePlatformFormatStatus(path.resolve(opts.indexPath), { videoId, platform: "bilibili", status: "formatted" });
        sendJson(res, 200, { ok: true, platform: "bilibili", ...(genStatus ? { genStatus } : {}), ...result });
      } else if (platform === "x") {
        await updatePlatformFormatStatus(path.resolve(opts.indexPath), { videoId, platform: "x", status: "formatted" });
        sendJson(res, 200, { ok: true, platform: "x", outputDir: path.join(articleDir, "x-format"), files: [] });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  // ── platform init (reset) ──
  if (req.method === "POST" && url.pathname === "/api/platform-init") {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return;
    }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    if (!isSafeVideoId(videoId) || platform === null) {
      sendJson(res, 400, { error: "Invalid videoId or platform." });
      return;
    }

    // Check if platform is already published — refuse init
    const idx = await readPublishIndex(opts.indexPath);
    const platformState = idx.videos?.[videoId]?.platforms?.[platform];
    if (platformState?.published === true) {
      sendJson(res, 400, { error: "已发布的平台不可初始化。请先取消发布状态。" });
      return;
    }

    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);
    const deleted: string[] = [];

    // All platform artifacts are now inside the format directory.
    // Deleting the directory removes everything: articles, metadata, images, clips, prompts, HTML.
    const formatDir = { x: "x-format", xiaohongshu: "xiaohongshu-format", wechat: "wechat-format", bilibili: "bilibili-format" }[platform]!;
    const toDelete = [path.join(articleDir, formatDir)];

    // Delete files
    for (const p of toDelete) {
      try {
        await rm(p, { recursive: true, force: true });
        deleted.push(path.relative(articleDir, p));
      } catch {
        // file may not exist — skip
      }
    }

    // Reset platform state in publish-index.json
    if (idx.videos?.[videoId]?.platforms?.[platform] !== undefined) {
      const current = idx.videos[videoId]!.platforms![platform]!;
      idx.videos[videoId]!.platforms![platform] = {
        published: current.published ?? false,
        url: current.url ?? "",
        note: current.note ?? "",
        // Clear all format-related fields
      };
      await writePublishIndex(opts.indexPath, idx);
    }

    sendJson(res, 200, { ok: true, platform, deleted });
    return;
  }

  // serve xiaohongshu format HTML preview
  if (req.method === "GET" && url.pathname === "/api/xiaohongshu-format/file") {
    const videoId = url.searchParams.get("videoId");
    if (videoId === null || !isSafeVideoId(videoId)) {
      sendJson(res, 400, { error: "Invalid videoId." });
      return;
    }
    const dir = path.join(path.resolve(opts.articleOutDir), videoId, "xiaohongshu-format");
    const htmlPath = path.join(dir, "article.html");
    try {
      let html = await readFile(htmlPath, "utf8");
      const imageBase = "/api/xiaohongshu-format/image?videoId=" + encodeURIComponent(videoId) + "&file=";
      html = html.replace(/src="images\/([^"]+)"/g, (_match: string, file: string) => 'src="' + imageBase + encodeURIComponent(file) + '"');
      sendText(res, 200, html, "text/html; charset=utf-8");
    } catch {
      sendJson(res, 404, { error: "Xiaohongshu format not found." });
    }
    return;
  }

  // serve xiaohongshu format images
  if (req.method === "GET" && url.pathname === "/api/xiaohongshu-format/image") {
    const videoId = url.searchParams.get("videoId");
    const file = url.searchParams.get("file");
    if (videoId === null || !isSafeVideoId(videoId) || file === null || file.length === 0 || file.includes("/") || file.includes("\\") || file.includes("..")) {
      sendJson(res, 400, { error: "Invalid videoId or file." });
      return;
    }
    const imagePath = path.join(path.resolve(opts.articleOutDir), videoId, "xiaohongshu-format", "images", file);
    if (!path.resolve(imagePath).startsWith(path.join(path.resolve(opts.articleOutDir), videoId))) {
      sendJson(res, 400, { error: "Invalid file path." });
      return;
    }
    try {
      const ext = path.extname(file).toLowerCase();
      const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
      const data = await readFile(imagePath);
      res.writeHead(200, { "content-type": mimeTypes[ext] ?? "application/octet-stream", "cache-control": "public, max-age=3600" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Image not found." });
    }
    return;
  }

  // serve bilibili format text
  if (req.method === "GET" && url.pathname === "/api/bilibili-format/file") {
    const videoId = url.searchParams.get("videoId");
    if (videoId === null || !isSafeVideoId(videoId)) {
      sendJson(res, 400, { error: "Invalid videoId." });
      return;
    }
    const mdPath = path.join(path.resolve(opts.articleOutDir), videoId, "bilibili-format", "video-info.md");
    try {
      sendText(res, 200, await readFile(mdPath, "utf8"), "text/markdown; charset=utf-8");
    } catch {
      sendJson(res, 404, { error: "Bilibili format not found." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/platform-orchestrate") {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    if (!isRecord(parsed)) {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return;
    }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    if (!isSafeVideoId(videoId) || platform === null) {
      sendJson(res, 400, { error: "Invalid videoId or platform." });
      return;
    }
    const provider = defaultCliLlmProvider();
    const apiKey = readLlmApiKeyFromEnv(provider);
    if (apiKey === undefined) {
      sendJson(res, 400, { error: "No LLM API key configured." });
      return;
    }
    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);
    let articleMd = "";
    try {
      articleMd = await readFile(path.join(articleDir, "article.md"), "utf8");
    } catch {
      // Let the orchestrator fall back to an empty article.
    }
    const baseUrlMap: Record<string, string> = { openai: "https://api.openai.com/v1", deepseek: "https://api.deepseek.com/v1", moonshot: "https://api.moonshot.cn/v1", anthropic: "https://api.anthropic.com/v1" };
    const modelMap: Record<string, string> = { openai: "gpt-4o-mini", deepseek: "deepseek-v4-pro", moonshot: "moonshot-v1-8k", anthropic: "claude-sonnet-4-20250514" };
    const cfg: LlmFactoryConfig = { provider, apiKey, baseUrl: baseUrlMap[provider] ?? "https://api.openai.com/v1", defaultModel: modelMap[provider] ?? "deepseek-v4-pro" };
    try {
      const llm = createLlmAdapter(cfg);
      const result = await orchestratePlatformPrompts({ articleDir, videoId, articleMd, platform, llm, llmModel: cfg.defaultModel! });
      sendJson(res, 200, { ok: true, platform, ...result });
    } catch (err: unknown) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/platform-orchestrate/preview") {
    const videoId = url.searchParams.get("videoId");
    const platformParam = url.searchParams.get("platform");
    const mode = url.searchParams.get("mode");
    const platform = platformParam === null ? null : platformFromString(platformParam);
    if (videoId === null || !isSafeVideoId(videoId) || platform === null) {
      sendJson(res, 400, { error: "Invalid videoId or platform." });
      return;
    }
    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);

    // Published mode: show actual images
    if (mode === "published") {
      const existingPreview = await previewExistingArticleImages(articleDir, platform);
      if (existingPreview !== null) {
        sendText(res, 200, existingPreview.html, "text/html; charset=utf-8");
      } else {
        sendJson(res, 404, { error: "No images available for preview." });
      }
      return;
    }

    // Live preview: always read article + images directly
    // Load prompts.json for this platform to inject prompt placeholders
    const formatDirs: Record<string, string> = { x: "x-format", xiaohongshu: "xiaohongshu-format", wechat: "wechat-format", bilibili: "bilibili-format" };
    let promptMap: Map<number, string> | undefined;
    try {
      const promptsPath = path.join(articleDir, formatDirs[platform] ?? "", "prompts.json");
      const promptsRaw = await readFile(promptsPath, "utf8");
      const prompts = JSON.parse(promptsRaw) as { illustrationPrompts?: Array<{ index: number; prompt: string }> };
      // prompts.json exists = user has formatted. Even if empty (all sections have images), don't show "尚未排版".
      promptMap = new Map((prompts.illustrationPrompts ?? []).map((il) => [il.index, il.prompt]));
    } catch { /* no prompts yet */ }

    const livePreview = await previewExistingArticleImages(articleDir, platform, promptMap);
    if (livePreview !== null) {
      sendText(res, 200, livePreview.html, "text/html; charset=utf-8");
    } else {
      sendJson(res, 404, { error: "No article content available for preview." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/file-image") {
    const videoId = url.searchParams.get("videoId");
    const file = url.searchParams.get("file");
    const subdir = url.searchParams.get("subdir");
    if (videoId === null || !isSafeVideoId(videoId) || file === null || file.length === 0 || file.includes("/") || file.includes("\\") || file.includes("..")) {
      sendJson(res, 400, { error: "Invalid videoId or file." });
      return;
    }
    const articleRoot = path.join(path.resolve(opts.articleOutDir), videoId);
    // Platform-specific dir first, then fallback to images/ and x-format/images/
    const dirs = subdir
      ? [path.join(articleRoot, subdir, "images"), path.join(articleRoot, "images")]
      : [path.join(articleRoot, "images"), path.join(articleRoot, "x-format", "images")];
    let served = false;
    for (const imageDir of dirs) {
      const imagePath = path.join(imageDir, file);
      if (!path.resolve(imagePath).startsWith(path.resolve(imageDir) + path.sep)) continue;
      try {
        const ext = path.extname(file).toLowerCase();
        const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
        const data = await readFile(imagePath);
        res.writeHead(200, { "content-type": mimeTypes[ext] ?? "application/octet-stream", "cache-control": "public, max-age=3600" });
        res.end(data);
        served = true;
        break;
      } catch { /* try next dir */ }
    }
    if (!served) sendJson(res, 404, { error: "Image not found." });
    return;
  }

  // ── prompt edit/delete ──
  if (req.method === "POST" && url.pathname === "/api/prompts/update") {
    let parsed; try { parsed = JSON.parse(await readBody(req).catch(function(){return"{}"})); } catch { sendJson(res, 400, { error: "无效的 JSON 请求体" }); return; }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    const promptId = typeof parsed.promptId === "string" ? parsed.promptId : "";
    const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";
    if (!isSafeVideoId(videoId) || platform === null || !promptId || !promptText) {
      sendJson(res, 400, { error: "缺少必要字段" }); return;
    }
    const formatDirs: Record<string, string> = { x: "x-format", xiaohongshu: "xiaohongshu-format", wechat: "wechat-format", bilibili: "bilibili-format" };
    const formatDir = formatDirs[platform];
    if (!formatDir) { sendJson(res, 400, { error: "无效平台" }); return; }
    const promptsPath = path.join(path.resolve(opts.articleOutDir), videoId, formatDir, "prompts.json");
    try {
      const raw = await readFile(promptsPath, "utf8");
      const prompts = JSON.parse(raw) as Record<string, unknown>;
      const match = promptId.match(/^(cover|ill)(?:-(\d+))?$/);
      if (!match) { sendJson(res, 400, { error: "无效 promptId" }); return; }
      const type = match[1]!;
      const idx = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
      let found = false;
      if (type === "cover") {
        const covers = prompts.coverPrompts as Array<Record<string, unknown>> | undefined;
        if (covers && idx >= 0 && idx < covers.length) { covers[idx]!.prompt = promptText; found = true; }
      } else if (type === "ill") {
        const ills = prompts.illustrationPrompts as Array<Record<string, unknown>> | undefined;
        if (ills) { const il = ills.find((i) => i.index === idx); if (il) { il.prompt = promptText; found = true; } }
      }
      if (!found) { sendJson(res, 404, { error: "未找到该 prompt" }); return; }
      await writeFile(promptsPath, JSON.stringify(prompts, null, 2) + "\n", "utf8");
      sendJson(res, 200, { ok: true });
    } catch (err: unknown) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompts/delete") {
    let parsed; try { parsed = JSON.parse(await readBody(req).catch(function(){return"{}"})); } catch { sendJson(res, 400, { error: "无效的 JSON 请求体" }); return; }
    const videoId = typeof parsed.videoId === "string" ? parsed.videoId : "";
    const platform = typeof parsed.platform === "string" ? platformFromString(parsed.platform) : null;
    const promptId = typeof parsed.promptId === "string" ? parsed.promptId : "";
    if (!isSafeVideoId(videoId) || platform === null || !promptId) {
      sendJson(res, 400, { error: "缺少必要字段" }); return;
    }
    const formatDirs: Record<string, string> = { x: "x-format", xiaohongshu: "xiaohongshu-format", wechat: "wechat-format", bilibili: "bilibili-format" };
    const formatDir = formatDirs[platform];
    if (!formatDir) { sendJson(res, 400, { error: "无效平台" }); return; }
    const promptsPath = path.join(path.resolve(opts.articleOutDir), videoId, formatDir, "prompts.json");
    try {
      const raw = await readFile(promptsPath, "utf8");
      const prompts = JSON.parse(raw) as Record<string, unknown>;
      const match = promptId.match(/^(cover|ill)(?:-(\d+))?$/);
      if (!match) { sendJson(res, 400, { error: "无效 promptId" }); return; }
      const type = match[1]!;
      const idx = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
      let found = false;
      if (type === "cover") {
        const covers = prompts.coverPrompts as Array<Record<string, unknown>> | undefined;
        if (covers && idx >= 0 && idx < covers.length) { prompts.coverPrompts = covers.filter((_, i) => i !== idx); found = true; }
      } else if (type === "ill") {
        const ills = prompts.illustrationPrompts as Array<Record<string, unknown>> | undefined;
        if (ills) {
          const lenBefore = ills.length;
          const filtered = ills.filter((i) => i.index !== idx);
          prompts.illustrationPrompts = filtered;
          found = filtered.length < lenBefore;
        }
      }
      if (!found) { sendJson(res, 404, { error: "未找到该 prompt" }); return; }
      await writeFile(promptsPath, JSON.stringify(prompts, null, 2) + "\n", "utf8");
      sendJson(res, 200, { ok: true });
    } catch (err: unknown) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // debug: check image generator status
  if (req.method === "GET" && url.pathname === "/api/debug") {
    sendJson(res, 200, {
      imageGenerator: opts.imageGenerator !== undefined,
      hasImageApiKey: (process.env["YT2X_IMAGE_API_KEY"] ?? "").length > 0,
      hasOpenAiKey: (process.env["OPENAI_API_KEY"] ?? "").length > 0,
    });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
};

export const registerDashboardCommand = (program: Command): void => {
  program
    .command("dashboard")
    .description("Open a local dashboard for article files and publish status.")
    .option("--port <port>", "Dashboard port", "4321")
    .option("--host <host>", "Dashboard host", "127.0.0.1")
    .option("--article-out-dir <path>", "Article output root", DEFAULT_ARTICLE_OUT_DIR)
    .option("--out-dir <path>", "Downloads/notes root", DEFAULT_OUT_DIR)
    .option("--index <path>", "Publish status index path", "files/publish-index.json")
    .option("--wechat-formatter-dir <path>", "Path to xiaohu-wechat-format checkout (or WECHAT_FORMATTER_DIR)")
    .action(async (flags: { port: string; host: string; articleOutDir: string; outDir: string; index: string; wechatFormatterDir?: string }) => {
      const port = Number.parseInt(flags.port, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid --port: ${flags.port}`);
      }
      // image generator: use dedicated env vars so it doesn't conflict with LLM text generation
      let imageGenerator: ImageGeneratorPort | undefined;
      const imageApiKey = process.env["YT2X_IMAGE_API_KEY"] ?? process.env["OPENAI_API_KEY"];
      if (imageApiKey !== undefined && imageApiKey.length > 0) {
        const imageBaseUrl = process.env["YT2X_IMAGE_BASE_URL"] ?? "https://api.openai.com/v1";
        const imageModel = process.env["YT2X_IMAGE_MODEL"] ?? "dall-e-3";
        imageGenerator = createImageGeneratorAdapter({ apiKey: imageApiKey, baseUrl: imageBaseUrl, defaultModel: imageModel });
      }
      const wechatFormatterDir = flags.wechatFormatterDir ?? process.env["WECHAT_FORMATTER_DIR"];
      const opts = {
        articleOutDir: path.resolve(flags.articleOutDir),
        downloadsDir: path.resolve(flags.outDir),
        indexPath: path.resolve(flags.index),
        ...(wechatFormatterDir !== undefined ? { wechatFormatterDir: path.resolve(wechatFormatterDir) } : {}),
        ...(imageGenerator !== undefined ? { imageGenerator } : {}),
      };
      // Migrate legacy X platform files into x-format/ subdirectory (idempotent)
      const { migrateXFilesToFormatDir } = await import("./migrate-x-files.js");
      const migrated = await migrateXFilesToFormatDir(path.resolve(flags.articleOutDir));
      if (migrated > 0) {
        process.stderr.write(`migrated ${migrated} X platform file(s) into x-format/ subdirectories\n`);
      }

      const server = createServer((req, res) => {
        handleDashboardRequest(req, res, opts).catch((err: unknown) => {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      });
      server.listen(port, flags.host, () => {
        process.stdout.write(`yt2x dashboard running at http://${flags.host}:${port}/\n`);
        process.stdout.write(`status index: ${opts.indexPath}\n`);
      });
    });
};
