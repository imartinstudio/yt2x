import { describe, expect, it } from "vitest";
import {
  formatXContentBody,
  formatXTweetMarkdownItem,
  parseGeneratedThreadMarkdown,
  renderXThreadMarkdown,
  renderXShortMarkdown,
  normalizeXThreadMarkdown,
} from "./x-content-markdown.js";

describe("formatXContentBody", () => {
  it("keeps single newlines as hard breaks in preview", () => {
    expect(formatXContentBody("第一行\n第二行")).toBe("第一行  \n第二行");
  });

  it("forces a blank line after colon subheadings", () => {
    expect(formatXContentBody("超级应用的崛起：\nSuper-app 不再只是菜单更少")).toBe(
      "**超级应用的崛起：**\n\nSuper-app 不再只是菜单更少",
    );
  });

  it("splits inline bold colon title from body when thread marker is present", () => {
    expect(
      formatXTweetMarkdownItem(2, 8, "先查账号归属地：头像→服务条款，看页面显示的国家。"),
    ).toBe(["2/8 **先查账号归属地：**", "", "头像→服务条款，看页面显示的国家。"].join("\n"));
  });

  it("reflows fused **title:**body lines in existing markdown", () => {
    const normalized = normalizeXThreadMarkdown(
      "1/ **a：**body one\n\n2/ **先查账号归属地：**头像→服务条款",
    );
    expect(normalized).toContain("2/2 **先查账号归属地：**\n\n头像→服务条款");
  });

  it("converts parallel colon lines into unordered markdown lists", () => {
    const formatted = formatXContentBody(
      "传统浏览器：窗口式、标签页\n新范式：按 tab / project\n每个任务有上下文",
    );
    expect(formatted).toContain("- **传统浏览器：**");
    expect(formatted).toContain("- **新范式：**");
    expect(formatted).toContain("每个任务有上下文");
  });

  it("formats section with numbered predictions as 预测 N subheadings", () => {
    const formatted = formatXContentBody(
      [
        "未来预测：",
        "1",
        "Claude Code 和 Codex 将支持每个会话打开多个浏览器标签页。",
        "2",
        "代理将根据任务自动打开相关工具。",
        "写推文时，代理自动打开 Notion 和 Typefully。",
        "3",
        "生成式迷你应用——代理自动生成 UI 供你审阅和发送。",
      ].join("\n"),
    );
    expect(formatted).toBe(
      [
        "未来预测：",
        "",
        "预测 1：Claude Code 和 Codex 将支持每个会话打开多个浏览器标签页。",
        "",
        "预测 2：代理将根据任务自动打开相关工具。  ",
        "写推文时，代理自动打开 Notion 和 Typefully。",
        "",
        "预测 3：生成式迷你应用——代理自动生成 UI 供你审阅和发送。",
      ].join("\n"),
    );
  });

  it("merges repeated section headers in numbered prediction blocks", () => {
    const formatted = formatXContentBody(
      ["未来预测：", "预测 1：", "第一条", "", "未来预测：", "预测 2：", "第二条"].join("\n"),
    );
    expect(formatted).toBe(["未来预测：", "", "预测 1：第一条", "", "预测 2：第二条"].join("\n"));
    expect(formatted.match(/未来预测：/gu)?.length).toBe(1);
  });

  it("renders numbered predictions inline on one line per item", () => {
    expect(
      formatXTweetMarkdownItem(
        5,
        8,
        [
          "未来预测：",
          "1",
          "每个代理会话将支持多个浏览器标签页。",
          "2",
          "代理根据任务自动打开相关工具——写推文时自动打开 Notion 和 Typefully。",
          "3",
          "生成式迷你应用——代理自动生成 UI 供你审阅和发送，就像告诉电脑做什么，然后微调即可。",
        ].join("\n"),
      ),
    ).toBe(
      [
        "5/8 未来预测：",
        "",
        "预测 1：每个代理会话将支持多个浏览器标签页。",
        "",
        "预测 2：代理根据任务自动打开相关工具——写推文时自动打开 Notion 和 Typefully。",
        "",
        "预测 3：生成式迷你应用——代理自动生成 UI 供你审阅和发送，就像告诉电脑做什么，然后微调即可。",
      ].join("\n"),
    );
  });

  it("splits merged 未来预测 1 into section and 预测 N subheadings", () => {
    const formatted = formatXTweetMarkdownItem(
      4,
      8,
      [
        "未来预测 1:",
        "Claude Code 和 Codex 将支持每个会话打开多个浏览器标签页。",
        "预测 2:",
        "代理将根据任务自动打开相关工具。",
        "预测 3:",
        "生成式迷你应用",
      ].join("\n"),
    );
    expect(formatted).toContain("4/8 未来预测：");
    expect(formatted).toContain("预测 1：Claude Code");
    expect(formatted).toContain("预测 2：代理");
    expect(formatted).not.toContain("未来预测 1");
  });
});

describe("formatXTweetMarkdownItem", () => {
  it("renders tweet with current/total position marker", () => {
    expect(formatXTweetMarkdownItem(2, 8, "超级应用的崛起：\n正文 A\n正文 B")).toBe(
      ["2/8 **超级应用的崛起：**", "", "正文 A  ", "正文 B"].join("\n"),
    );
  });
});

describe("renderXThreadMarkdown", () => {
  it("renders tweets with position markers instead of markdown lists", () => {
    expect(
      renderXThreadMarkdown({
        title: "t",
        planning: {
          core_thesis: "c",
          conflict: "x",
          key_points: ["a", "b", "c", "d"],
          reader_gain: "g",
          final_post: "f",
        },
        tweets: ["判断：first", "收益：second"],
        hooks: [{ text: "h", angle: "a", risk: "low" }],
      }),
    ).toBe(["1/2 **判断：**", "", "first", "", "2/2 **收益：**", "", "second", ""].join("\n"));
  });
});

describe("renderXShortMarkdown", () => {
  it("formats short post body for markdown preview", () => {
    expect(
      renderXShortMarkdown({
        text: "核心：判断\n1\n步骤一\n2\n步骤二",
        angle: "practical",
        risk: "low",
      }),
    ).toContain("**核心：**");
    expect(
      renderXShortMarkdown({
        text: "核心：判断\n1\n步骤一\n2\n步骤二",
        angle: "practical",
        risk: "low",
      }),
    ).toMatch(/1\.\s+步骤一/);
  });
});

describe("parseGeneratedThreadMarkdown", () => {
  it("splits legacy 1/ markers", () => {
    expect(parseGeneratedThreadMarkdown("1/ first\n\n2/ second")).toEqual(["first", "second"]);
  });

  it("splits position markers with total count", () => {
    expect(parseGeneratedThreadMarkdown("1/3 **标题：**\n\n正文\n\n2/3 第二条")).toEqual([
      "**标题：**\n\n正文",
      "第二条",
    ]);
  });

  it("does not split inner ordered or circled steps into new tweets", () => {
    const raw = [
      "1/ **收到账号后，必须做3件事：**",
      "1. 修改密码",
      "2. 验证辅助邮箱",
      "",
      "2/ **极客自建：**",
      "① 用 iPhone 注册",
      "② 在 RoxyBrowser 中登录",
    ].join("\n");
    expect(parseGeneratedThreadMarkdown(raw)).toEqual([
      "**收到账号后，必须做3件事：**\n1. 修改密码\n2. 验证辅助邮箱",
      "**极客自建：**\n① 用 iPhone 注册\n② 在 RoxyBrowser 中登录",
    ]);
  });
});

describe("normalizeXThreadMarkdown", () => {
  it("rewrites legacy 1/ markers to current/total format", () => {
    const normalized = normalizeXThreadMarkdown("1/ first\n\n2/ second");
    expect(normalized).toBe("1/2 first\n\n2/2 second\n");
  });
});
