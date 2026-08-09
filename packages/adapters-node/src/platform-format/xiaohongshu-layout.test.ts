import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import { formatXiaohongshuLayout } from "./xiaohongshu-layout.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "yt2x-xhs-terms-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("formatXiaohongshuLayout technical terms", () => {
  it("guards generated prompts and preserves ordinary image labels", async () => {
    const requests: ChatRequest[] = [];
    const response = (content: string): ChatResponse => ({ content, model: "task7-xhs", finishReason: "stop" });
    const llm: LlmPort = {
      chat: async (request) => {
        requests.push(request);
        const system = request.messages[0]?.content ?? "";
        if (system.includes("严格的源级专业术语发现器")) {
          return response(JSON.stringify([
            { sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" },
          ]));
        }
        if (system.includes("专业术语定向修复器")) {
          const user = request.messages[1]?.content ?? "";
          const currentJson = user.match(/Current value:\n([\s\S]*?)\n\n只输出修复后的值/u)?.[1] ?? "{}";
          const current = JSON.parse(currentJson) as { prompts: string[] };
          return response(JSON.stringify({
            prompts: current.prompts.map((prompt) => prompt
              .replaceAll("图工程", "Graph Engineering")
              .replaceAll("知识图谱", "Knowledge Graph")
              .replaceAll("潜在工作区路由", "Latent Workspace Routing")),
          }));
        }
        return response("图工程和知识图谱；潜在工作区路由；保留配图和流程图标签。");
      },
    };
    const articleMd = [
      "# Graph Engineering",
      "",
      "Graph Engineering connects a Knowledge Graph to Latent Workspace Routing.",
      "",
      "Knowledge Graph 的配图和流程图要保持清晰。",
    ].join("\n");

    const result = await formatXiaohongshuLayout({
      articleDir: tmpRoot,
      videoId: "task7-xhs-terms",
      articleMd,
      llm,
      llmModel: "task7-xhs",
    });
    const prompts = JSON.parse(await readFile(path.join(result.outputDir, "prompts.json"), "utf8")) as {
      illustrationPrompts: Array<{ prompt: string }>;
      technicalTermProfileFingerprint: string;
    };
    const promptText = prompts.illustrationPrompts.map((item) => item.prompt).join("\n");

    expect(promptText).toContain("Graph Engineering");
    expect(promptText).toContain("Knowledge Graph");
    expect(promptText).toContain("Latent Workspace Routing");
    expect(promptText).toContain("配图");
    expect(promptText).toContain("流程图");
    expect(promptText).not.toContain("图工程和知识图谱");
    expect(prompts.technicalTermProfileFingerprint).toMatch(/^sha256-[0-9a-f]{64}$/u);
    expect(await readFile(path.join(result.outputDir, "article.html"), "utf8")).toContain("Latent Workspace Routing");
    expect(requests.filter((request) => request.messages[0]?.content.includes("严格的源级专业术语发现器"))).toHaveLength(1);
    expect(requests.filter((request) => request.messages[0]?.content.includes("专业术语定向修复器"))).toHaveLength(1);
  });

  it("invalidates legacy and stale prompt caches instead of treating them as hits", async () => {
    const formatDir = path.join(tmpRoot, "xiaohongshu-format");
    const articleMd = "# Graph Engineering\n\n## Section\n正文。";
    await mkdir(formatDir, { recursive: true });
    await writeFile(path.join(formatDir, "prompts.json"), JSON.stringify(["legacy cached prompt"]), "utf8");

    const requests: ChatRequest[] = [];
    const response = (content: string): ChatResponse => ({ content, model: "cache-test", finishReason: "stop" });
    const llm: LlmPort = {
      chat: async (request) => {
        requests.push(request);
        const system = request.messages[0]?.content ?? "";
        if (system.includes("严格的源级专业术语发现器")) return response("[]");
        return response("Graph Engineering fresh generated visual prompt");
      },
    };

    const first = await formatXiaohongshuLayout({ articleDir: tmpRoot, videoId: "cache-legacy", articleMd, llm, llmModel: "cache-test" });
    const firstPrompts = JSON.parse(await readFile(path.join(first.outputDir, "prompts.json"), "utf8")) as { illustrationPrompts: Array<{ prompt: string }>; technicalTermProfileFingerprint: string };
    expect(firstPrompts.illustrationPrompts.map((item) => item.prompt).join("\n")).toContain("fresh generated visual prompt");
    expect(firstPrompts.technicalTermProfileFingerprint).toMatch(/^sha256-[0-9a-f]{64}$/u);
    const firstRequestCount = requests.length;

    await writeFile(path.join(formatDir, "prompts.json"), JSON.stringify({
      prompts: ["stale cached prompt"],
      technicalTermProfileFingerprint: "fnv1a-stale-catalog-or-source",
    }), "utf8");
    const changedArticleMd = "# Graph Engineering\n\n## Changed source\n正文。";
    await formatXiaohongshuLayout({ articleDir: tmpRoot, videoId: "cache-stale", articleMd: changedArticleMd, llm, llmModel: "cache-test" });
    expect(requests.length).toBeGreaterThan(firstRequestCount);
  });

  it("merges concurrent adapter writers into the canonical prompt schema", async () => {
    const articleMd = "# Graph Engineering\n\n## Section\nKnowledge Graph and Agent Graph。";
    const response = (content: string): ChatResponse => ({ content, model: "race-test", finishReason: "stop" });
    const llm: LlmPort = {
      chat: async (request) => {
        const system = request.messages[0]?.content ?? "";
        const user = request.messages[1]?.content ?? "";
        if (system.includes("严格的源级专业术语发现器")) return response("[]");
        if (system.includes("Create a cover image-generation prompt")) return response("cover prompt");
        if (user.includes("Create a sketch-knowledge-kit illustration prompt for section")) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return response("Graph Engineering Knowledge Graph Agent Graph section prompt");
        }
        return response(JSON.stringify([{ index: 1, filename: "illustration.png", name: "插图", prompt: "section prompt" }]));
      },
    };

    const { orchestratePlatformPrompts } = await import("./prompt-orchestrator.js");
    await Promise.all([
      orchestratePlatformPrompts({ articleDir: tmpRoot, videoId: "race-video", articleMd, platform: "xiaohongshu", llm, llmModel: "race-test" }),
      formatXiaohongshuLayout({ articleDir: tmpRoot, videoId: "race-video", articleMd, llm, llmModel: "race-test" }),
    ]);

    const prompts = JSON.parse(await readFile(path.join(tmpRoot, "xiaohongshu-format", "prompts.json"), "utf8")) as {
      coverPrompts: unknown[];
      illustrationPrompts: unknown[];
      technicalTermProfileFingerprint: string;
    };
    expect(prompts.coverPrompts).toHaveLength(1);
    expect(prompts.illustrationPrompts.length).toBeGreaterThan(0);
    expect(prompts.technicalTermProfileFingerprint).toMatch(/^sha256-[0-9a-f]{64}$/u);
  });

  it("does not overwrite stale prompts when the adapter has no LLM", async () => {
    const articleMd = "# Graph Engineering\n\n## Section\nKnowledge Graph content.";
    const formatDir = path.join(tmpRoot, "xiaohongshu-format");
    await mkdir(formatDir, { recursive: true });
    const stalePrompts = {
      platform: "xiaohongshu",
      title: "Graph Engineering",
      model: "old-model",
      technicalTermProfileFingerprint: "fnv1a-stale",
      coverPrompts: [{ label: "封面", prompt: "old cover", size: "1080×1440", filename: "cover.png", name: "旧封面" }],
      illustrationPrompts: [{ index: 0, text: "Section", prompt: "old illustration", filename: "section-01.png", name: "旧插图" }],
    };
    const staleJson = JSON.stringify(stalePrompts, null, 2) + "\n";
    await writeFile(path.join(formatDir, "prompts.json"), staleJson, "utf8");

    await formatXiaohongshuLayout({ articleDir: tmpRoot, videoId: "no-llm-stale", articleMd });

    await expect(readFile(path.join(formatDir, "prompts.json"), "utf8")).resolves.toBe(staleJson);
  });
});
