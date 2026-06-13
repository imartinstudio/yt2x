import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_ARTICLE_OUT_DIR, DEFAULT_OUT_DIR, formatWechatArticle } from "@yt2x/adapters-node";
import { executeNativeArticle } from "../orchestrator/native-article.js";

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
  updatedAt: string | null;
  articleDir: string | null;
  downloadDir: string | null;
  platforms: Record<
    PlatformKey,
    {
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
  const formattedDir = path.join(articleDir, "wechat-format", "wechat-article");
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
      const formatPaths = platform.key === "wechat" && hasArticleDir ? wechatFormatPaths(articleDir) : null;
      const hasFormattedWechat = formatPaths !== null
        && (await fileExists(formatPaths.htmlPath))
        && (await fileExists(formatPaths.previewPath));
      platforms[platform.key] = {
        generated: files.length > 0,
        published: state.published === true,
        url: typeof state.url === "string" ? state.url : "",
        note: typeof state.note === "string" ? state.note : "",
        files,
        formatStatus: state.formatStatus === "failed"
          ? "failed"
          : state.formatStatus === "formatted" || hasFormattedWechat
            ? "formatted"
            : "none",
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

    videos.push({
      videoId,
      title,
      originalTitle: originalTitle !== null && originalTitle !== title ? originalTitle : null,
      updatedAt,
      articleDir: hasArticleDir ? articleDir : null,
      downloadDir: hasDownloadDir ? downloadDir : null,
      platforms,
    });
  }

  videos.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
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
): Promise<void> => {
  const index = await readPublishIndex(indexPath);
  index.videos ??= {};
  index.videos[input.videoId] ??= {};
  index.videos[input.videoId]!.platforms ??= {};
  const current = index.videos[input.videoId]!.platforms!.wechat ?? {};
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
  index.videos[input.videoId]!.platforms!.wechat = next;
  await writePublishIndex(indexPath, index);
};

const formatWechatForDashboard = async (
  opts: { articleOutDir: string; indexPath: string; wechatFormatterDir?: string },
  input: { videoId: string; theme: string },
): Promise<{ theme: string; htmlPath: string; previewPath: string }> => {
  const result = await formatWechatArticle({
    articleDir: path.join(path.resolve(opts.articleOutDir), input.videoId),
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
};

const generateWechatArticleForDashboard = async (
  opts: { articleOutDir: string; downloadsDir: string },
  videoId: string,
): Promise<void> => {
  const code = await executeNativeArticle({
    videoId: [videoId],
    outDir: opts.downloadsDir,
    articleOutDir: opts.articleOutDir,
    platformTargets: "wechat",
    showProgress: false,
  });
  if (code !== 0) {
    throw new Error(`WeChat article generation failed with exit code ${code}. Check LLM configuration and source article files.`);
  }
};

const platformFromString = (value: string | null): PlatformKey | null => {
  if (value === "x" || value === "xiaohongshu" || value === "wechat" || value === "bilibili") return value;
  return null;
};

const isSafeVideoId = (value: string): boolean =>
  value.length > 0 && !value.includes("/") && !value.includes("\\");

const fileForPlatform = (platform: PlatformKey): string =>
  PLATFORMS.find((item) => item.key === platform)?.primaryFile ?? "article.md";

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>yt2x Dashboard</title>
  <style>
    :root {
      --ink: #202019;
      --muted: #68685f;
      --line: #dedbd0;
      --panel: #fbfaf5;
      --paper: #f3f0e6;
      --accent: #0e6f5c;
      --accent-2: #c7512f;
      --ok: #0d7a4f;
      --warn: #a84c25;
      --shadow: 0 16px 45px rgba(32, 32, 25, 0.08);
      --header-h: 82px;
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(32,32,25,.045) 1px, transparent 1px) 0 0 / 28px 28px,
        linear-gradient(rgba(32,32,25,.035) 1px, transparent 1px) 0 0 / 28px 28px,
        var(--paper);
    }

    header {
      min-height: var(--header-h);
      padding: 18px 24px;
      display: grid;
      grid-template-columns: 280px 1fr auto;
      align-items: end;
      gap: 22px;
      border-bottom: 1px solid var(--line);
      background: rgba(251,250,245,.9);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 5;
    }

    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 25px;
      letter-spacing: .01em;
    }

    .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .filters { display: grid; grid-template-columns: 1fr 160px 160px; gap: 10px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #fffdf8;
      color: var(--ink);
      border-radius: 6px;
      padding: 10px 11px;
      font: inherit;
      font-size: 13px;
    }
    select {
      appearance: none;
      padding-right: 34px;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 18px) 50%,
        calc(100% - 13px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    textarea { min-height: 74px; resize: vertical; }
    button {
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #fffdf8;
      border-radius: 6px;
      padding: 9px 11px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
    button.ghost { background: transparent; color: var(--muted); border-color: transparent; padding: 6px 7px; }

    main {
      display: grid;
      grid-template-columns: minmax(760px, 1fr) 360px;
      min-height: calc(100vh - var(--header-h));
    }

    .table-wrap { padding: 22px 20px 28px; overflow: auto; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric {
      background: rgba(251,250,245,.82);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .metric b { display: block; font-size: 22px; line-height: 1.1; font-family: Georgia, serif; }
    .metric span { color: var(--muted); font-size: 12px; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: rgba(251,250,245,.92);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: middle;
      font-size: 13px;
    }
    th {
      position: sticky;
      top: var(--header-h);
      background: #ede8da;
      z-index: 2;
      color: #48483f;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    tr { cursor: pointer; }
    tr:hover td { background: #fffdf8; }
    tr.active td { background: #e9f3ee; }
    .title { max-width: 430px; font-weight: 650; line-height: 1.35; }
    .original-title {
      max-width: 430px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
      margin-top: 2px;
    }
    .video-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #8d8b80;
      font-size: 11px;
      margin-top: 2px;
    }
    .date { color: var(--muted); white-space: nowrap; font-size: 12px; }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 58px;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #fffdf8;
    }
    .pill.generated { color: var(--warn); border-color: #e3b49c; background: #fff3ec; }
    .pill.published { color: var(--ok); border-color: #9bcdb7; background: #edf8f2; }
    .platform-cell { min-width: 74px; }

    aside {
      border-left: 1px solid var(--line);
      background: rgba(251,250,245,.86);
      padding: 18px;
      position: sticky;
      top: var(--header-h);
      height: calc(100vh - var(--header-h));
      overflow: auto;
    }
    .detail-title { font-family: Georgia, serif; font-size: 22px; line-height: 1.2; margin: 0 0 8px; }
    .detail-original-title { color: var(--muted); font-size: 12px; line-height: 1.35; margin: -2px 0 8px; }
    .detail-meta { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
    .platform-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffdf8;
      padding: 12px;
      margin-bottom: 10px;
    }
    .platform-card input,
    .platform-card textarea {
      display: block;
      margin-top: 8px;
    }
    .platform-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .platform-name { font-weight: 750; }
    .switch {
      display: inline-grid;
      grid-template-columns: 1fr 1fr;
      width: 128px;
      flex: 0 0 128px;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: #f7f3e8;
    }
    .switch button {
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--muted);
      padding: 6px 7px;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
    }
    .switch button.on {
      background: var(--accent);
      color: #fff;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 9px 0; }
    .file-list { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .empty { color: var(--muted); padding: 32px; text-align: center; }
    .toast {
      position: fixed;
      right: 20px;
      bottom: 20px;
      background: var(--ink);
      color: #fffdf8;
      padding: 10px 12px;
      border-radius: 7px;
      opacity: 0;
      transform: translateY(8px);
      transition: .18s ease;
      pointer-events: none;
      z-index: 20;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    @media (max-width: 1060px) {
      header { grid-template-columns: 1fr; height: auto; align-items: start; }
      .filters { grid-template-columns: 1fr; }
      main { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-left: 0; border-top: 1px solid var(--line); }
      th { top: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>yt2x 控制台</h1>
      <div class="sub" id="sourceLine">扫描本地文件中...</div>
    </div>
    <div class="filters">
      <input id="search" placeholder="搜索标题、videoId、备注或链接" />
      <select id="platformFilter">
        <option value="all">全部平台</option>
        <option value="x">X</option>
        <option value="xiaohongshu">小红书</option>
        <option value="wechat">公众号</option>
        <option value="bilibili">B站</option>
      </select>
      <select id="statusFilter">
        <option value="all">全部状态</option>
        <option value="generated">已有稿件</option>
        <option value="published">已发布</option>
        <option value="unpublished">未发布</option>
      </select>
    </div>
    <button id="refresh">刷新</button>
  </header>
  <main>
    <section class="table-wrap">
      <div class="summary" id="summary"></div>
      <table>
        <thead>
          <tr>
            <th>视频</th>
            <th>更新时间</th>
            <th>X</th>
            <th>小红书</th>
            <th>公众号</th>
            <th>B站</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
    <aside id="detail">
      <div class="empty">选择一个视频查看稿件和发布状态。</div>
    </aside>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const platformLabels = { x: "X", xiaohongshu: "小红书", wechat: "公众号", bilibili: "B站" };
    const platformOrder = ["x", "xiaohongshu", "wechat", "bilibili"];
    let payload = null;
    let selectedId = null;

    const $ = (id) => document.getElementById(id);
    const toast = (text) => {
      const el = $("toast");
      el.textContent = text;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 3500);
    };
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-";
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    async function load() {
      const resp = await fetch("/api/videos");
      payload = await resp.json();
      if (!selectedId && payload.videos.length > 0) selectedId = payload.videos[0].videoId;
      $("sourceLine").textContent = payload.videos.length + " 个视频 · " + payload.articleOutDir;
      render();
    }

    function filteredVideos() {
      const q = $("search").value.trim().toLowerCase();
      const platform = $("platformFilter").value;
      const status = $("statusFilter").value;
      return payload.videos.filter((video) => {
        const blob = [
          video.videoId,
          video.title,
          ...platformOrder.flatMap((p) => [video.platforms[p].url, video.platforms[p].note, video.platforms[p].files.join(" ")])
        ].join("\n").toLowerCase();
        if (q && !blob.includes(q)) return false;
        const platforms = platform === "all" ? platformOrder : [platform];
        if (status === "generated" && !platforms.some((p) => video.platforms[p].generated)) return false;
        if (status === "published" && !platforms.some((p) => video.platforms[p].published)) return false;
        if (status === "unpublished" && !platforms.some((p) => video.platforms[p].generated && !video.platforms[p].published)) return false;
        return true;
      });
    }

    function renderSummary(videos) {
      const total = videos.length;
      const generated = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].generated).length, 0);
      const published = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].published).length, 0);
      const waiting = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].generated && !v.platforms[p].published).length, 0);
      $("summary").innerHTML = [
        ["视频", total],
        ["已生成平台稿", generated],
        ["已发布", published],
        ["待发布", waiting],
      ].map(([label, value]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join("");
    }

    function platformPill(state) {
      if (state.published) return '<span class="pill published">已发布</span>';
      if (state.generated) return '<span class="pill generated">未发布</span>';
      return '<span class="pill">无稿件</span>';
    }

    function renderRows(videos) {
      $("rows").innerHTML = videos.map((video) => [
        '<tr class="' + (video.videoId === selectedId ? "active" : "") + '" data-id="' + esc(video.videoId) + '">',
        '<td><div class="title">' + esc(video.title) + '</div>' +
          (video.originalTitle ? '<div class="original-title">' + esc(video.originalTitle) + '</div>' : "") +
          '<div class="video-id">' + esc(video.videoId) + '</div></td>',
        '<td class="date">' + esc(fmtDate(video.updatedAt)) + '</td>',
        platformOrder.map((p) => '<td class="platform-cell">' + platformPill(video.platforms[p]) + '</td>').join(""),
        '</tr>',
      ].join("")).join("");
      document.querySelectorAll("tr[data-id]").forEach((row) => {
        row.addEventListener("click", () => {
          selectedId = row.dataset.id;
          render();
        });
      });
    }

    function renderDetail() {
      const video = payload.videos.find((item) => item.videoId === selectedId);
      if (!video) {
        $("detail").innerHTML = '<div class="empty">没有匹配的视频。</div>';
        return;
      }
      $("detail").innerHTML = [
        '<h2 class="detail-title">' + esc(video.title) + '</h2>',
        video.originalTitle ? '<div class="detail-original-title">原视频标题：' + esc(video.originalTitle) + '</div>' : "",
        '<div class="detail-meta">' + esc(video.videoId) + '<br>' + esc(video.articleDir || "无 article 目录") + '</div>',
        platformOrder.map((p) => renderPlatformCard(video, p)).join(""),
      ].join("");
      $("detail").querySelectorAll("[data-save]").forEach((btn) => {
        btn.addEventListener("click", () => savePlatform(video.videoId, btn.dataset.save, btn.dataset.value));
      });
      $("detail").querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", () => copyPlatform(video.videoId, btn.dataset.copy));
      });
      $("detail").querySelectorAll("[data-format-wechat]").forEach((btn) => {
        btn.addEventListener("click", () => formatWechat(video.videoId, btn.dataset.theme || "github"));
      });
      $("detail").querySelectorAll("[data-generate-wechat]").forEach((btn) => {
        btn.addEventListener("click", () => generateAndFormatWechat(video.videoId, btn.dataset.theme || "github"));
      });
      $("detail").querySelectorAll("[data-copy-wechat-html]").forEach((btn) => {
        btn.addEventListener("click", () => copyWechatHtml(video.videoId));
      });
    }

    function renderPlatformCard(video, platform) {
      const state = video.platforms[platform];
      const formatLine = platform === "wechat"
        ? '<div class="file-list">排版：' +
          (state.formatStatus === "formatted"
            ? "已排版" + (state.formatTheme ? " · " + esc(state.formatTheme) : "")
            : state.formatStatus === "failed"
              ? "失败 · " + esc(state.formatError || "未知错误")
              : "未排版") +
          '</div>'
        : "";
      const wechatActions = platform === "wechat"
        ? [
          state.generated
            ? '<button class="secondary" data-format-wechat="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "github") + '">' + (state.formatStatus === "formatted" ? "重新排版" : "排版") + '</button>'
            : video.platforms.x.generated
              ? '<button class="secondary" data-generate-wechat="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "github") + '">生成并排版</button>'
              : '<button class="secondary" disabled>缺主稿</button>',
          '<button class="secondary" data-copy-wechat-html="' + esc(video.videoId) + '" ' + (state.formatStatus === "formatted" ? "" : "disabled") + '>复制 HTML</button>',
          '<a href="/api/wechat-format/file?videoId=' + encodeURIComponent(video.videoId) + '&kind=preview" target="_blank"><button class="secondary" ' + (state.formatStatus === "formatted" ? "" : "disabled") + '>打开预览</button></a>',
        ].join("")
        : "";
      return [
        '<section class="platform-card">',
        '<div class="platform-head">',
        '<div>',
        '<div class="platform-name">' + platformLabels[platform] + '</div>',
        '<div class="file-list">' + (state.files.length ? state.files.map(esc).join(" · ") : "未生成稿件") + '</div>',
        formatLine,
        '</div>',
        '<div class="switch">',
        '<button data-save="' + platform + '" data-value="false" class="' + (!state.published ? "on" : "") + '">未发布</button>',
        '<button data-save="' + platform + '" data-value="true" class="' + (state.published ? "on" : "") + '">已发布</button>',
        '</div>',
        '</div>',
        '<input data-url="' + platform + '" placeholder="发布链接" value="' + esc(state.url) + '" />',
        '<textarea data-note="' + platform + '" placeholder="备注">' + esc(state.note) + '</textarea>',
        '<div class="actions">',
        '<button data-save="' + platform + '" data-value="' + String(state.published) + '">保存状态</button>',
        '<button class="secondary" data-copy="' + platform + '" ' + (state.generated ? "" : "disabled") + '>复制稿件</button>',
        '<a href="/api/file?videoId=' + encodeURIComponent(video.videoId) + '&platform=' + platform + '" target="_blank"><button class="secondary" ' + (state.generated ? "" : "disabled") + '>打开稿件</button></a>',
        wechatActions,
        '</div>',
        '</section>',
      ].join("");
    }

    async function savePlatform(videoId, platform, value) {
      const active = value === "true";
      const url = document.querySelector('[data-url="' + platform + '"]').value;
      const note = document.querySelector('[data-note="' + platform + '"]').value;
      const resp = await fetch("/api/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, platform, published: active, url, note }),
      });
      if (!resp.ok) {
        toast("保存失败");
        return;
      }
      toast("已保存");
      await load();
    }

    async function copyPlatform(videoId, platform) {
      const resp = await fetch("/api/file?videoId=" + encodeURIComponent(videoId) + "&platform=" + platform);
      if (!resp.ok) {
        toast("没有可复制的稿件");
        return;
      }
      await navigator.clipboard.writeText(await resp.text());
      toast("已复制稿件");
    }

    async function formatWechat(videoId, theme) {
      toast("开始排版公众号稿...");
      const resp = await fetch("/api/wechat-format", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, theme }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        toast(payload.error || "排版失败");
        await load();
        return;
      }
      toast("公众号排版完成");
      await load();
    }

    async function generateAndFormatWechat(videoId, theme) {
      toast("开始生成公众号稿并排版...");
      const resp = await fetch("/api/wechat-generate-format", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, theme }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        toast(payload.error || "生成或排版失败");
        await load();
        return;
      }
      toast("公众号稿已生成并排版");
      await load();
    }

    async function copyWechatHtml(videoId) {
      const resp = await fetch("/api/wechat-format/file?videoId=" + encodeURIComponent(videoId) + "&kind=html");
      if (!resp.ok) {
        toast("没有可复制的 HTML");
        return;
      }
      await navigator.clipboard.writeText(await resp.text());
      toast("已复制 HTML");
    }

    function render() {
      const videos = filteredVideos();
      renderSummary(videos);
      renderRows(videos);
      renderDetail();
    }

    $("refresh").addEventListener("click", load);
    $("search").addEventListener("input", render);
    $("platformFilter").addEventListener("change", render);
    $("statusFilter").addEventListener("change", render);
    load().catch((err) => {
      $("rows").innerHTML = '<tr><td colspan="6">加载失败：' + esc(err.message) + '</td></tr>';
    });
  </script>
</body>
</html>`;

const handleDashboardRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  opts: { articleOutDir: string; downloadsDir: string; indexPath: string; wechatFormatterDir?: string },
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
      sendText(res, 200, await readFile(filePath, "utf8"), "text/html; charset=utf-8");
    } catch {
      sendJson(res, 404, { error: "WeChat formatted file not found." });
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
  if (req.method === "POST" && url.pathname === "/api/wechat-generate-format") {
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
      const articleDir = path.join(path.resolve(opts.articleOutDir), videoId);
      if (!(await fileExists(path.join(articleDir, "wechat-article.md")))) {
        await generateWechatArticleForDashboard(opts, videoId);
      }
      const result = await formatWechatForDashboard(opts, { videoId, theme });
      sendJson(res, 200, { ok: true, generated: true, ...result });
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
      const opts = {
        articleOutDir: path.resolve(flags.articleOutDir),
        downloadsDir: path.resolve(flags.outDir),
        indexPath: path.resolve(flags.index),
        ...(flags.wechatFormatterDir !== undefined ? { wechatFormatterDir: path.resolve(flags.wechatFormatterDir) } : {}),
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
