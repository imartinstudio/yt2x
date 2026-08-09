import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      prompts: string[];
      technicalTermProfileFingerprint: string;
    };
    const promptText = prompts.prompts.join("\n");

    expect(promptText).toContain("Graph Engineering");
    expect(promptText).toContain("Knowledge Graph");
    expect(promptText).toContain("Latent Workspace Routing");
    expect(promptText).toContain("配图");
    expect(promptText).toContain("流程图");
    expect(promptText).not.toContain("图工程和知识图谱");
    expect(prompts.technicalTermProfileFingerprint).toMatch(/^fnv1a-/u);
    expect(await readFile(path.join(result.outputDir, "article.html"), "utf8")).toContain("Latent Workspace Routing");
    expect(requests.filter((request) => request.messages[0]?.content.includes("严格的源级专业术语发现器"))).toHaveLength(1);
    expect(requests.filter((request) => request.messages[0]?.content.includes("专业术语定向修复器"))).toHaveLength(1);
  });
});
