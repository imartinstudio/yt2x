#!/usr/bin/env node
/* global process */
/**
 * 检查 downloads 是否被加工产物污染。
 * 用法: node scripts/check-downloads-readonly.mjs [downloadsRoot]
 * 默认: <repo>/files/downloads（跟随符号链接）
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOWNLOADS_FORBIDDEN_NAME_RE =
  /(?:^|[._-])(?:zh-)?(?:bilingual-)?(?:burned|dubbed)(?:[._-]|$)|watermark/iu;

const isForbiddenName = (name) => DOWNLOADS_FORBIDDEN_NAME_RE.test(name);

const walkFiles = async (root) => {
  const out = [];

  const visit = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let kind = "other";

      if (entry.isSymbolicLink()) {
        // files/ 常是仓库外符号链接；必须跟随，否则检查会静默扫空。
        try {
          const target = await realpath(full);
          const st = await lstat(target);
          kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
        } catch {
          continue;
        }
      } else if (entry.isDirectory()) {
        kind = "dir";
      } else if (entry.isFile()) {
        kind = "file";
      }

      if (kind === "dir") await visit(full);
      else if (kind === "file") out.push(full);
    }
  };

  try {
    await visit(await realpath(root));
  } catch {
    await visit(root);
  }

  return out;
};

export const findDownloadsPollution = async (downloadsRoot) => {
  const findings = [];
  const files = await walkFiles(downloadsRoot);
  const rootReal = await realpath(downloadsRoot).catch(() => downloadsRoot);

  for (const filePath of files) {
    const rel = path.relative(rootReal, filePath);
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts.length === 0) continue;
    const videoId = parts[0];
    const base = path.basename(filePath);
    if (isForbiddenName(base)) {
      findings.push({
        videoId,
        relativePath: rel,
        reason: `processed artifact name is forbidden under downloads: ${base}`,
      });
    }
  }

  return findings;
};

export const formatDownloadsPollutionReport = (findings) => {
  if (findings.length === 0) return "downloads readonly check: clean\n";
  return [
    `downloads readonly check: ${findings.length} pollution finding(s)`,
    ...findings.map((f) => `- [${f.videoId}] ${f.relativePath}: ${f.reason}`),
    "",
  ].join("\n");
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const downloadsRoot = path.resolve(process.argv[2] ?? path.join(repoRoot, "files/downloads"));
  const findings = await findDownloadsPollution(downloadsRoot);
  process.stdout.write(formatDownloadsPollutionReport(findings));
  process.exitCode = findings.length === 0 ? 0 : 1;
}
