import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

/** 采集 review 阶段：终端 yes/no 确认 */
export const createAcquireReviewPrompt =
  (): ((videoId: string) => Promise<"yes" | "no" | "quit">) =>
  async (videoId: string) => {
    const rl = createInterface({ input, output });
    const answer = await rl.question(`   👀 Review acquire result for ${videoId} — proceed? [Y/n/q] `);
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "quit") return "quit";
    if (trimmed === "n" || trimmed === "no") return "no";
    return "yes";
  };
