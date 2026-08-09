import { describe, expect, it } from "vitest";
import {
  createTechnicalTermGuard,
  restoreProtectedTechnicalTermsInContent,
  restoreProtectedTechnicalTermsInValue,
} from "./technical-terms.js";

const sourceNotes = [
  "# Why Graph Engineering will 10x your Claude/Codex",
  "",
  "图工程（Graph Engineering）是一种工作流设计方法。",
  "知识图谱（Knowledge Graph）帮助 AI 理解实体关系。",
  "代理图谱（Agent Graph）描述工作如何流动。",
  "提示工程（Prompt Engineering）和上下文工程（Context Engineering）也必须保留原名。",
].join("\n");

describe("technical term restoration", () => {
  it("keeps the current restoration wrapper compatible with the central guard", () => {
    const guard = createTechnicalTermGuard({ sourceText: sourceNotes });
    const prepared = guard.prepare("图工程和知识图谱");

    expect(guard.finalize("图工程和知识图谱", prepared.restoration).value).toBe(
      "Graph Engineering 和 Knowledge Graph",
    );
  });

  it("restores source technical terms in plain content while preserving ordinary image words", () => {
    const content = [
      "图工程需要把工作拆开。",
      "知识图谱 vs 代理图谱。",
      "图的基本词汇。",
      "截图、缩略图和图片不能被改写。",
      "提示工程和上下文工程必须保留原名。",
    ].join("\n");

    expect(restoreProtectedTechnicalTermsInContent(content, sourceNotes, "Why Graph Engineering")).toBe(
      [
        "Graph Engineering 需要把工作拆开。",
        "Knowledge Graph vs Agent Graph。",
        "Graph 的基本词汇。",
        "截图、缩略图和图片不能被改写。",
        "Prompt Engineering 和 Context Engineering 必须保留原名。",
      ].join("\n"),
    );
  });

  it("restores every textual field in nested JSON-like output values", () => {
    const output = {
      title: "图工程",
      body: "知识图谱和代理图谱",
      tags: ["图工程", "工作流"],
      nested: { hook: "上下文工程与提示工程" },
    };

    expect(restoreProtectedTechnicalTermsInValue(output, sourceNotes, "Why Graph Engineering")).toEqual({
      title: "Graph Engineering",
      body: "Knowledge Graph 和 Agent Graph",
      tags: ["Graph Engineering", "工作流"],
      nested: { hook: "Context Engineering 与 Prompt Engineering" },
    });
  });

  it("keeps 图文 image wording Chinese when Graph protection is active", () => {
    expect(restoreProtectedTechnicalTermsInContent("图文说明和图的基本词汇", "Graph is useful.")).toBe(
      "图文说明和 Graph 的基本词汇",
    );
  });
});
