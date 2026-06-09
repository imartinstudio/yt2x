import type { Command } from "commander";
import path from "node:path";
import { selectClips, generateClipsPosts, publishClips, createLlmAdapter } from "@yt2x/adapters-node";
import { resolveLlmConfig, defaultCliLlmProvider } from "../config/env.js";
import { logger } from "../logger.js";

const resolveArticleDir = (videoId: string, monorepoRoot: string): string =>
  videoId.includes("/") ? videoId : path.join(monorepoRoot, "files/articles", videoId);

export const registerClipsCommand = (program: Command): void => {
  const clips = program
    .command("clips")
    .description("Manage video clip candidates: select, generate posts, publish");

  // ── select ──
  clips
    .command("select")
    .description("Select which candidates to keep from deconstruct output")
    .argument("<video-id>", "Video ID (e.g. HQGUed-e2wM) under files/articles/")
    .argument("<ids...>", "Clip IDs to keep (e.g. 1,3,5 or clip-1 clip-3 clip-5)")
    .action(async (videoId: string, ids: string[]) => {
      const { defaultMonorepoRoot } = await import("../config/monorepo-root.js");
      const articleDir = resolveArticleDir(videoId, defaultMonorepoRoot());

      // Flatten if ids is a single comma-separated string
      const keep = ids.length === 1 ? ids[0]!.split(",").map((s) => s.trim()) : ids;

      logger.info({ articleDir, keep }, "Clips select");

      try {
        const result = await selectClips({ articleDir, keep });
        console.log(`\n✅ 已选中 ${result.kept} 个片段，已删除 ${result.removed} 个未选中文件`);
        console.log(`   Manifest: ${result.manifestPath}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, "Clips select failed");
        process.exitCode = 1;
      }
    });

  // ── generate ──
  clips
    .command("generate")
    .description("Generate optimized X post text for selected clips")
    .argument("<video-id>", "Video ID or article dir path")
    .option("--llm-provider <id>", "LLM provider override")
    .option("--llm-model <name>", "LLM model override")
    .action(async (videoId: string, options: { llmProvider?: string; llmModel?: string }) => {
      const { defaultMonorepoRoot } = await import("../config/monorepo-root.js");
      const articleDir = resolveArticleDir(videoId, defaultMonorepoRoot());

      const llmConfig = resolveLlmConfig({
        provider: (options.llmProvider ?? defaultCliLlmProvider()) as "openai" | "anthropic" | "deepseek" | "moonshot",
        ...(options.llmModel ? { model: options.llmModel } : {}),
      });
      const llm = createLlmAdapter({
        provider: llmConfig.provider,
        apiKey: llmConfig.apiKey ?? "",
        baseUrl: llmConfig.baseUrl ?? "",
      });
      if (llmConfig.model !== undefined) {
        (llm as { defaultModel?: string }).defaultModel = llmConfig.model;
      }

      logger.info({ articleDir, provider: llmConfig.provider, model: llmConfig.model }, "Clips generate");

      try {
        const result = await generateClipsPosts({
          llm,
          model: llmConfig.model ?? "",
          articleDir,
        });
        console.log(`\n✅ 已生成 ${result.postCount} 篇帖子文案`);
        for (const p of result.postPaths) {
          console.log(`   ${p}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, "Clips generate failed");
        process.exitCode = 1;
      }
    });

  // ── publish (dry-run only) ──
  clips
    .command("publish")
    .description("Preview or publish selected clips (dry-run by default)")
    .argument("<video-id>", "Video ID or article dir path")
    .option("--dry-run", "Preview without posting (default)", true)
    .action(async (videoId: string, _options: { dryRun?: boolean }) => {
      const { defaultMonorepoRoot } = await import("../config/monorepo-root.js");
      const articleDir = resolveArticleDir(videoId, defaultMonorepoRoot());

      logger.info({ articleDir }, "Clips publish (dry-run)");

      try {
        const result = await publishClips({ articleDir, dryRun: true });
        console.log(`\n📋 ${result.total} 篇帖子就绪（dry-run，未真实发帖）`);
        console.log(`   运行 pnpm yt2x auth 配置 X OAuth 后可启用真实发布`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ error: msg }, "Clips publish failed");
        process.exitCode = 1;
      }
    });
};
