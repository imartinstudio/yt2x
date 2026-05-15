import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const CLI_SRC_DIR = path.dirname(__filename);

/** Monorepo 根目录（从 `packages/cli/src/config` 向上四层） */
export const defaultMonorepoRoot = (): string => path.resolve(CLI_SRC_DIR, "..", "..", "..", "..");
