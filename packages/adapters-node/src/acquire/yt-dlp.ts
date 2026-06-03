import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessRunner } from "../process/index.js";
import { fingerprintChanged, subtitleFingerprint } from "./subtitle-files.js";
import { screenshotsDirHasOfficialYoutubeThumbnail } from "./screenshots.js";
import { youtubeSubLangBase } from "./youtube-sub-lang.js";

export type YtDlpOptions = {
  cookiesFromBrowser?: string;
  proxy?: string;
  runner: ProcessRunner;
  timeoutMs: number;
  signal?: AbortSignal;
};

export const buildYtDlpArgs = (opts: Pick<YtDlpOptions, "cookiesFromBrowser" | "proxy">): string[] => {
  const cmd = ["yt-dlp"];
  if (opts.proxy !== undefined && opts.proxy.length > 0) {
    cmd.push("--proxy", opts.proxy);
  }
  if (opts.cookiesFromBrowser !== undefined && opts.cookiesFromBrowser.length > 0) {
    cmd.push("--cookies-from-browser", opts.cookiesFromBrowser);
  }
  return cmd;
};

const runYtDlp = async (
  opts: YtDlpOptions,
  extraArgs: string[],
  runOpts?: { check?: boolean; stdio?: "pipe" | "inherit" },
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const result = await opts.runner.run({
    command: "yt-dlp",
    args: [...buildYtDlpArgs(opts).slice(1), ...extraArgs],
    timeoutMs: opts.timeoutMs,
    stdio: runOpts?.stdio ?? "pipe",
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (runOpts?.check !== false && result.exitCode !== 0) {
    throw new Error(
      `yt-dlp exited ${result.exitCode}: ${result.stderr.slice(0, 1200) || result.stdout.slice(0, 1200)}`,
    );
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

/**
 * 通过 `--write-info-json` 落盘再读取，避免 `--dump-single-json`  stdout 超过
 * ProcessRunner 默认 512KB 截断导致 JSON 解析失败。
 */
export const fetchVideoMetadata = async (
  url: string,
  opts: YtDlpOptions,
): Promise<Record<string, unknown>> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "yt2x-ytdlp-meta-"));
  try {
    const outTemplate = path.join(tempDir, "video.%(ext)s");
    await runYtDlp(opts, ["--skip-download", "--write-info-json", "-o", outTemplate, url]);
    const names = await readdir(tempDir);
    const infoName = names.find((n) => n.endsWith(".info.json"));
    if (infoName === undefined) {
      throw new Error("yt-dlp did not write .info.json (check cookies / network)");
    }
    const raw = await readFile(path.join(tempDir, infoName), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

export const runYtDlpSubtitles = async (
  url: string,
  videoDir: string,
  opts: YtDlpOptions & { writeManual: boolean; subLangs: string },
): Promise<void> => {
  const args = [
    "--skip-download",
    "--convert-subs",
    "srt",
    "-o",
    pathJoinPattern(videoDir),
  ];
  if (opts.writeManual) {
    args.push("--write-subs", "--no-write-auto-subs");
  } else {
    args.push("--write-auto-subs", "--no-write-subs");
  }
  args.push("--sub-langs", opts.subLangs, url);
  await runYtDlp(opts, args, { check: false });
};

/** yt-dlp output template segment — title/id/ext placeholders. */
const pathJoinPattern = (videoDir: string): string =>
  `${videoDir.replace(/\/$/, "")}/%(title).180B.%(id)s.%(ext)s`;

export const downloadSubtitlesTwoPhase = async (
  url: string,
  videoDir: string,
  opts: YtDlpOptions & { videoLanguage: string; manualSubLangs: string },
): Promise<{ manualOk: boolean; autoOk: boolean }> => {
  const lang = (opts.videoLanguage || "en").trim() || "en";
  const primaryAutoLang = youtubeSubLangBase(lang);

  const before = await subtitleFingerprint(videoDir);

  await runYtDlpSubtitles(url, videoDir, {
    ...opts,
    writeManual: true,
    subLangs: opts.manualSubLangs,
  });
  const afterManual = await subtitleFingerprint(videoDir);
  const manualOk = fingerprintChanged(before, afterManual);
  if (manualOk) {
    return { manualOk: true, autoOk: false };
  }

  // 自动字幕回退策略：优先尝试简体中文自动字幕，再回退繁体、视频语言和英文
  const autoFallbacks = [...new Set([
    "zh-CN", "zh-Hans", "zh", "zh-Hant", "zh-TW",
    primaryAutoLang, "en"
  ])];

  for (const subLang of autoFallbacks) {
    await runYtDlpSubtitles(url, videoDir, {
      ...opts,
      writeManual: false,
      subLangs: subLang,
    });
    const after = await subtitleFingerprint(videoDir);
    if (fingerprintChanged(before, after) || fingerprintChanged(afterManual, after)) {
      return { manualOk: false, autoOk: true };
    }
  }

  return { manualOk: false, autoOk: false };
};

/** 解析直链供 ffmpeg 流式读取，避免为 scene 检测下载整段视频。 */
export const resolveDirectVideoUrl = async (url: string, opts: YtDlpOptions): Promise<string> => {
  const { stdout } = await runYtDlp(opts, [
    "-f",
    "bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720][ext=mp4]/best[height<=720]",
    "-g",
    url,
  ]);
  const line = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (line === undefined) {
    throw new Error("yt-dlp -g returned no stream URL");
  }
  return line;
};

export const ensureOfficialYoutubeThumbnail = async (
  url: string,
  videoDir: string,
  opts: YtDlpOptions,
  warnings: string[],
): Promise<string | undefined> => {
  if (await screenshotsDirHasOfficialYoutubeThumbnail(videoDir)) {
    return undefined;
  }

  const screenshotsDir = path.join(videoDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const result = await runYtDlp(
    opts,
    [
      "--skip-download",
      "--write-thumbnail",
      "-o",
      `${screenshotsDir}/youtube_cover.%(ext)s`,
      url,
    ],
    { check: false },
  );

  if (result.exitCode !== 0) {
    warnings.push(
      `official thumbnail: yt-dlp exited ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`,
    );
    return undefined;
  }

  let names: string[] = [];
  try {
    names = await readdir(screenshotsDir);
  } catch {
    names = [];
  }
  const thumbs = names
    .filter(
      (n) =>
        n.toLowerCase().startsWith("youtube_cover.") &&
        /\.(webp|jpg|jpeg|png)$/i.test(n),
    )
    .sort();
  if (thumbs.length > 0) {
    return thumbs[0];
  }
  warnings.push("official thumbnail: yt-dlp ok but no youtube_cover.* image found");
  return undefined;
};
