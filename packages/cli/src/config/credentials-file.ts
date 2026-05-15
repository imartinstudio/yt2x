import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { LlmProviderSchema } from "../args/llm.js";

const CredentialsFileSchema = z.object({
  llm: z
    .record(
      LlmProviderSchema,
      z.object({
        apiKey: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
        model: z.string().min(1).optional(),
      }),
    )
    .optional(),
  x: z
    .object({
      clientId: z.string().min(1).optional(),
    })
    .optional(),
});
export type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

export const defaultCredentialsPath = (): string =>
  path.join(homedir(), ".config", "yt2x", "credentials.json");

/**
 * 读取并校验凭证文件。文件不存在时返回 null（视为未配置，不报错）。
 */
export const loadCredentialsFile = async (
  filePath: string = defaultCredentialsPath(),
): Promise<CredentialsFile | null> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  return CredentialsFileSchema.parse(parsed);
};
