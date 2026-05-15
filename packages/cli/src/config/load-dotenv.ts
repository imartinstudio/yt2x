import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

/** 本文件位于 `packages/cli/src/config/` → 上溯四级到 monorepo 根 */
export const monorepoRootFromCliPackage = (): string =>
  path.resolve(path.dirname(__filename), "..", "..", "..", "..");

export const parseDotEnvContent = (content: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
};

/**
 * 将仓库根（及 cwd）下的 `.env` 合并进 `process.env`。
 * 不覆盖已存在的非空环境变量（与常见 dotenv 行为一致）。
 */
export const applyRepoDotEnv = (env: NodeJS.ProcessEnv = process.env): void => {
  const root = monorepoRootFromCliPackage();
  const candidates = [path.join(root, ".env"), path.join(process.cwd(), ".env")];
  const seen = new Set<string>();
  for (const filePath of candidates) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      const raw = readFileSync(resolved, "utf8");
      const parsed = parseDotEnvContent(raw);
      for (const [k, v] of Object.entries(parsed)) {
        const cur = env[k];
        if (cur === undefined || cur === "") {
          env[k] = v;
        }
      }
    } catch {
      // 文件不存在或不可读：忽略
    }
  }
};
