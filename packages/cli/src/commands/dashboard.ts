import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  DEFAULT_ARTICLE_OUT_DIR,
  DEFAULT_OUT_DIR,
  formatWechatArticle,
  formatWechatCovers,
  formatBilibiliText,
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
  { key: "x", label: "X", primaryFile: "article.md", files: ["article.md", "x-thread.md", "x-short.md", "x-video-short.md"] },
  { key: "xiaohongshu", label: "小红书", primaryFile: "xiaohongshu-article.md", files: ["xiaohongshu-article.md"] },
  { key: "wechat", label: "公众号", primaryFile: "wechat-article.md", files: ["wechat-article.md"] },
  { key: "bilibili", label: "B站", primaryFile: "bilibili-article.md", files: ["bilibili-article.md"] },
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
      // Derive unified status: published > failed > formatted > draft > empty
      let pstatus: "empty" | "draft" | "formatted" | "published" | "failed" = "empty";
      if (published) pstatus = "published";
      else if (fmtStatus === "failed") pstatus = "failed";
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

  // escape leading # in hashtag lines so the formatter doesn't treat them as markdown headings.
  // a line starting with # followed by a word character (not whitespace) is a hashtag, not a heading.
  let originalMarkdown = "";
  let patched = false;
  try {
    originalMarkdown = await readFile(articlePath, "utf8");
    const escaped = originalMarkdown.replace(/^(#[^\s#*_\n])/gm, "\\$1");
    if (escaped !== originalMarkdown) {
      await writeFile(articlePath, escaped, "utf8");
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
    return [{ id: "github", name: "GitHub", description: "Default GitHub-inspired WeChat formatting theme." }];
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
  return themes.length > 0 ? themes : [{ id: "github", name: "GitHub", description: "" }];
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
          return '<div class="wx-prompt-card"><div class="wx-prompt-label">🎨 封面' + (cp.label ? ' · ' + cp.label.replace(/</g, "&lt;") : '') + '</div><div class="wx-prompt-box">' + cp.prompt.replace(/</g, "&lt;") + '</div><div class="wx-prompt-actions"><button onclick="navigator.clipboard.writeText(this.dataset.p)" data-p="' + cp.prompt.replace(/"/g, "&quot;") + '">📋 复制</button><a href="https://chatgpt.com/?q=' + encodeURIComponent(cp.prompt) + '" target="_blank">🤖 ChatGPT</a></div></div>';
        }).join("");
        const illCards = (prompts.illustrationPrompts ?? []).map(function (ip, i) {
          return '<div class="wx-prompt-card"><div class="wx-prompt-label">📷 ' + (ip.name ?? '插图 ' + (i + 1)) + '</div><div class="wx-prompt-box">' + ip.prompt.replace(/</g, "&lt;") + '</div><div class="wx-prompt-actions"><button onclick="navigator.clipboard.writeText(this.dataset.p)" data-p="' + ip.prompt.replace(/"/g, "&quot;") + '">📋 复制</button><a href="https://chatgpt.com/?q=' + encodeURIComponent(ip.prompt) + '" target="_blank">🤖 ChatGPT</a></div></div>';
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
    const theme = typeof parsed.theme === "string" && parsed.theme.trim().length > 0 ? parsed.theme.trim() : "github";
    if (!isSafeVideoId(videoId)) {
      sendJson(res, 400, { error: "Invalid videoId." });
      return;
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
    await updatePlatformStatus(path.resolve(opts.indexPath), {
      videoId,
      platform,
      published: parsed.published === true,
      url: typeof parsed.url === "string" ? parsed.url : "",
      note: typeof parsed.note === "string" ? parsed.note : "",
    });
    sendJson(res, 200, { ok: true });
    return;
  }
  // ── auto-generate platform article via LLM if missing ──
  const ensurePlatformArticle = async (videoId: string, targetPlatform: PlatformKey): Promise<string> => {
    if (targetPlatform === "x") return "";
    const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);
    const metadataFile = `${targetPlatform}-metadata.json`;

    // already generated?
    try { await readFile(path.join(articleDir, metadataFile)); return ""; } catch { /* nope */ }

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
      await writePlatformArticleBundle(path.resolve(opts.articleOutDir), videoId, result.platformArticle);
      return ""; // success
    } catch (err: unknown) {
      return `LLM生成失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

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
        const imgRefGlobal = /!\[.*?\]\(images\/([^)]+)\)/g;
        const hasImages = imgRefGlobal.test(articleMd);

        if (hasImages) {
          // Use existing images
          await formatWechatCovers({ articleDir, videoId, articleMd, ...(opts.imageGenerator !== undefined ? { imageGenerator: opts.imageGenerator } : {}) });
        } else {
          // No images — generate prompts via sketch-knowledge-kit
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
        }
        const theme = typeof parsed.theme === "string" && parsed.theme.trim().length > 0 ? parsed.theme.trim() : "notion-doc";
        const result = await formatWechatArticle({
          articleDir,
          sourceFile: "article.md",
          theme,
          ...(opts.wechatFormatterDir !== undefined ? { formatterDir: opts.wechatFormatterDir } : {}),
        });
        await updateWechatFormatStatus(path.resolve(opts.indexPath), { videoId, status: "formatted", theme: result.theme, htmlPath: result.articleHtmlPath, previewPath: result.previewHtmlPath });
        sendJson(res, 200, { ok: true, platform: "wechat", theme: result.theme });
      } else if (platform === "xiaohongshu") {
        await updatePlatformFormatStatus(path.resolve(opts.indexPath), { videoId, platform: "xiaohongshu", status: "formatted" });
        sendJson(res, 200, { ok: true, platform: "xiaohongshu", ...(genStatus ? { genStatus } : {}) });
      } else if (platform === "bilibili") {
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
    if (videoId === null || !isSafeVideoId(videoId) || file === null || file.length === 0 || file.includes("/") || file.includes("\\") || file.includes("..")) {
      sendJson(res, 400, { error: "Invalid videoId or file." });
      return;
    }
    const imageDir = path.join(path.resolve(opts.articleOutDir), videoId, "images");
    const imagePath = path.join(imageDir, file);
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
      };
      const data = await readFile(imagePath);
      res.writeHead(200, { "content-type": mimeTypes[ext] ?? "application/octet-stream", "cache-control": "public, max-age=3600" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Image not found." });
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
    .action((flags: { port: string; host: string; articleOutDir: string; outDir: string; index: string; wechatFormatterDir?: string }) => {
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
