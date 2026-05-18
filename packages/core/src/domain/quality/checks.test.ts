import { describe, expect, it } from "vitest";
import {
  checkArticleQuality,
  checkShortQuality,
  checkThreadQuality,
  formatQualityIssues,
} from "./checks.js";
import {
  ABSTRACT_FRAMEWORK_FIXTURE,
  HIGH_TRUST_FIXTURE,
} from "./fixtures.js";
import type { GeneratedShortPost } from "../short/types.js";
import type { GeneratedThread } from "../thread/types.js";

const GOOD_ARTICLE = `# **外区 Apple ID 实操指南**

外区 Apple ID 用错一步就可能账号锁定、余额清零。本文给你一份能直接照做的安全清单，覆盖注册、支付与日常维护。

## **注册前的最小检查清单**

注册顺利不靠运气，靠提前对齐这 4 项。

- 邮箱：未注册过 Apple ID
- 地址：真实可控的目标外区地址
- 网络：稳定外区出口 IP，全程不切换
- 设备：先退出当前所有 Apple ID

**关键结论：**风控触发点在「网络 + 设备 + 支付」三者的一致性，缺一不可。

## **支付与礼品卡安全做法**

\`\`\`text
1. 先购买面额合适的目标区礼品卡
2. 用礼品卡为账号充值，再绑定订阅
3. 退款必须走 reportaproblem.apple.com
\`\`\`

**注意：**礼品卡只在原区有效，购买前确认面额币种。

## **风险与适用边界**

最坏后果是账号锁定 24 小时甚至永久封禁。

- 余额无法恢复
- 已购内容失效
- 家庭共享中断

不接受私下渠道退款，避免资金损失。

来源：<YOUTUBE_URL>
`;

const BAD_ARTICLE_NO_BOLD_TITLE = `# 外区 Apple ID 实操指南

本视频介绍了如何注册一个外区 Apple ID 并且分享了一些经验和心得；接下来我们将从 注册流程、支付方式、日常维护、风险提醒、最佳实践等多个角度详细展开，希望对你有所启发，文末还会附赠一个值得收藏的清单和模板，请耐心阅读到最后并把它分享给身边有需要的朋友。

注册外区 Apple ID 涉及多个环节，包括邮箱准备、地址填写、网络切换、设备登录、支付方式、礼品卡购买、订阅绑定、退款流程、家庭共享、风控规避等。每一个环节都需要谨慎处理，否则容易导致账号锁定、资金损失或者订阅失效。视频作者在视频中分享了大量的实操经验，但这些经验并不一定适用于所有人，请根据自身情况判断。

如果你按照视频中的步骤操作仍然失败，可能是网络环境、地区限制或者账号策略发生了变化。这种情况下不要慌张，可以等待几小时再尝试，或者咨询有经验的朋友。`;

describe("checkArticleQuality", () => {
  it("returns no issues for a high quality article", () => {
    const issues = checkArticleQuality(GOOD_ARTICLE, {
      sourceText: `${HIGH_TRUST_FIXTURE.metadata.title}\n${HIGH_TRUST_FIXTURE.structuredNotesMd}`,
    });
    const codes = issues.map((i) => i.code);
    expect(codes).not.toContain("article.title-not-bold");
    expect(codes).not.toContain("article.title-missing");
    expect(codes).not.toContain("article.lead-too-long");
    expect(codes).not.toContain("article.lead-missing");
    expect(codes).not.toContain("article.no-sections");
    expect(codes).not.toContain("article.missing-risk-section");
    expect(codes).not.toContain("article.missing-executable-asset");
    expect(codes).not.toContain("article.author-phrase");
    expect(codes).not.toContain("article.summary-tone-hook");
  });

  it("flags non-bold title", () => {
    const issues = checkArticleQuality(BAD_ARTICLE_NO_BOLD_TITLE);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("article.title-not-bold");
  });

  it("flags lead longer than 120 chars", () => {
    const issues = checkArticleQuality(BAD_ARTICLE_NO_BOLD_TITLE);
    expect(issues.map((i) => i.code)).toContain("article.lead-too-long");
  });

  it("flags summary-tone hook", () => {
    const issues = checkArticleQuality(BAD_ARTICLE_NO_BOLD_TITLE);
    expect(issues.map((i) => i.code)).toContain("article.summary-tone-hook");
  });

  it("flags missing sections", () => {
    const issues = checkArticleQuality(
      `# **A**\n\n短导语\n\n这只是一个段落，没有任何 H2。`,
    );
    expect(issues.map((i) => i.code)).toContain("article.no-sections");
  });

  it("flags missing risk section when high-trust topic detected", () => {
    const md = `# **外区 Apple ID 申请**\n\n外区账号注册带来风控隐患。\n\n## **背景**\n\n背景说明。\n\n## **步骤**\n\n步骤说明。`;
    const issues = checkArticleQuality(md, {
      sourceText: "外区 Apple ID 申请 风控",
    });
    expect(issues.map((i) => i.code)).toContain("article.missing-risk-section");
  });

  it("does not require risk section for low-trust topic", () => {
    const md = `# **抽象框架笔记**\n\n直接上手的 3 个观点拆解。\n\n## **观点拆解**\n\n观点说明。\n\n1. step a\n2. step b\n3. step c`;
    const issues = checkArticleQuality(md, {
      sourceText: "抽象框架与思考工具", // intentionally low-trust
    });
    expect(issues.map((i) => i.code)).not.toContain("article.missing-risk-section");
  });

  it("flags missing executable asset", () => {
    const md = `# **抽象观点合集**\n\n短导语。\n\n## **观点 A**\n\n观点 A 的描述。\n\n## **观点 B**\n\n观点 B 的描述。`;
    const issues = checkArticleQuality(md);
    expect(issues.map((i) => i.code)).toContain("article.missing-executable-asset");
  });

  it("flags author phrase", () => {
    const issues = checkArticleQuality(BAD_ARTICLE_NO_BOLD_TITLE);
    expect(issues.map((i) => i.code)).toContain("article.author-phrase");
  });

  it("flags long paragraph", () => {
    const longParagraph = "句子内容".repeat(80);
    const md = `# **A**\n\n短导语。\n\n## **小节**\n\n${longParagraph}`;
    const issues = checkArticleQuality(md);
    expect(issues.map((i) => i.code)).toContain("article.long-paragraph");
  });

  it("flags too many consecutive paragraphs without anchor", () => {
    const para = "段落内容，长度足够测试。";
    const md = `# **A**\n\n短导语。\n\n## **小节**\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
    const issues = checkArticleQuality(md);
    expect(issues.map((i) => i.code)).toContain("article.too-many-consecutive-paragraphs");
  });
});

const GOOD_SHORT: GeneratedShortPost = {
  text: `**别被「外区账号教程」骗了：** 真正决定账号能不能活下来的是网络、设备、支付的一致性。

1. **邮箱与地址：** 必须使用未注册过 Apple ID 的邮箱与真实外区地址。
2. **网络一致性：** 注册过程中不要切换出口 IP，否则风控很快触发。
3. **支付方式：** 优先用礼品卡充值，跳过信用卡绑定。
4. **风险提醒：** 一旦账号被锁定，礼品卡余额与已购内容都可能无法恢复。
5. **可执行 prompt：** \`帮我整理一份外区 Apple ID 注册前的最小检查清单\`

回复你最担心哪一步出问题，我帮你拆出最稳路径。`,
  angle: "practical",
  risk: "medium",
};

describe("checkShortQuality", () => {
  it("returns no critical issues for a well-formed short", () => {
    const issues = checkShortQuality(GOOD_SHORT, {
      sourceText: HIGH_TRUST_FIXTURE.structuredNotesMd,
    });
    const codes = issues.map((i) => i.code);
    expect(codes).not.toContain("short.summary-tone-hook");
    expect(codes).not.toContain("short.list-out-of-range");
    expect(codes).not.toContain("short.no-executable-item");
    expect(codes).not.toContain("short.missing-risk-reminder");
    expect(codes).not.toContain("short.author-phrase");
  });

  it("flags list count out of range", () => {
    const post: GeneratedShortPost = {
      text: `**判断：** 工具用错了。

1. 一条
2. 两条`,
      angle: "practical",
      risk: "low",
    };
    const issues = checkShortQuality(post);
    expect(issues.map((i) => i.code)).toContain("short.list-out-of-range");
  });

  it("flags summary-tone hook in first sentence", () => {
    const post: GeneratedShortPost = {
      text: `本视频介绍了 yt-dlp 的常用参数。

1. 一条
2. 两条
3. 三条
4. 四条`,
      angle: "practical",
      risk: "low",
    };
    const issues = checkShortQuality(post);
    expect(issues.map((i) => i.code)).toContain("short.summary-tone-hook");
  });

  it("flags missing executable item", () => {
    const post: GeneratedShortPost = {
      text: `**判断：** 工具用错了。

1. 思考点一
2. 思考点二
3. 思考点三
4. 思考点四`,
      angle: "discussion",
      risk: "low",
    };
    const issues = checkShortQuality(post);
    expect(issues.map((i) => i.code)).toContain("short.no-executable-item");
  });

  it("flags missing risk reminder when high-trust topic detected", () => {
    const post: GeneratedShortPost = {
      text: `**判断：** 外区账号有套路。

1. **第一步：** 注册时填写正确地址
2. **第二步：** 准备好邮箱
3. **可执行步骤：** 切换 App Store 国家
4. **后续：** 使用礼品卡充值`,
      angle: "practical",
      risk: "medium",
    };
    const issues = checkShortQuality(post, {
      sourceText: "外区 Apple ID 注册 礼品卡 充值",
    });
    expect(issues.map((i) => i.code)).toContain("short.missing-risk-reminder");
  });

  it("flags author phrase", () => {
    const post: GeneratedShortPost = {
      text: `**判断：** 视频作者说错了。

1. 一条
2. 两条
3. 三条
4. 四条 \`命令\``,
      angle: "discussion",
      risk: "low",
    };
    const issues = checkShortQuality(post);
    expect(issues.map((i) => i.code)).toContain("short.author-phrase");
  });
});

const GOOD_THREAD: GeneratedThread = {
  title: "外区 Apple ID 风控避坑",
  planning: {
    core_thesis: "账号能否长期使用，取决于网络、设备、支付三者的一致性",
    conflict: "教程只讲注册，不讲风控触发点",
    key_points: [
      "网络一致性",
      "设备登录数量",
      "支付方式",
      "退款与封号边界",
    ],
    reader_gain: "拿到一份可立刻执行的风控规避清单",
    final_post: "外区 Apple ID 不是注册难，而是维护难",
  },
  tweets: [
    "**外区 Apple ID 不是注册难，而是维护难：** 真正让账号活下来的是网络、设备、支付三者的一致性。",
    "**网络一致性：** 注册到使用全程使用同一个外区出口 IP，避免触发跨区风控。",
    "**设备登录数量：** 单台设备登录的 Apple ID 越少越安全，避免设备指纹被关联。",
    "**支付方式：** 优先用礼品卡充值，不绑定信用卡，降低支付链路风险。",
    "**模板：** 我做了一份外区 Apple ID 注册前最小检查清单，可以直接复制使用。",
    "**风险提醒：** 一旦账号被锁定，礼品卡余额、已购内容、家庭共享都可能失效，且不接受私下渠道退款。",
    "你最担心哪一步出问题？回复你的具体场景，我帮你拆出最稳路径。",
  ],
  hooks: [
    { text: "外区账号风控避坑", angle: "实用收益", risk: "medium" },
    { text: "外区账号能活多久", angle: "争议判断", risk: "medium" },
    { text: "礼品卡 vs 信用卡", angle: "实用收益", risk: "medium" },
  ],
};

describe("checkThreadQuality", () => {
  it("returns no critical issues for a well-formed thread", () => {
    const issues = checkThreadQuality(GOOD_THREAD, {
      sourceText: HIGH_TRUST_FIXTURE.structuredNotesMd,
    });
    const codes = issues.map((i) => i.code);
    expect(codes).not.toContain("thread.tweets-out-of-range");
    expect(codes).not.toContain("thread.first-tweet-numbering");
    expect(codes).not.toContain("thread.first-tweet-summary-tone");
    expect(codes).not.toContain("thread.no-executable-tweet");
    expect(codes).not.toContain("thread.missing-risk-tweet");
    expect(codes).not.toContain("thread.author-phrase");
    expect(codes).not.toContain("thread.tweet-too-long");
  });

  it("flags tweets out of range (too few)", () => {
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: GOOD_THREAD.tweets.slice(0, 3),
    };
    const issues = checkThreadQuality(thread);
    expect(issues.map((i) => i.code)).toContain("thread.tweets-out-of-range");
  });

  it("flags first tweet starting with 1/", () => {
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: ["1/ 这是首推", ...GOOD_THREAD.tweets.slice(1)],
    };
    const issues = checkThreadQuality(thread);
    expect(issues.map((i) => i.code)).toContain("thread.first-tweet-numbering");
  });

  it("flags first tweet starting with 本视频", () => {
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: ["本视频介绍 yt-dlp", ...GOOD_THREAD.tweets.slice(1)],
    };
    const issues = checkThreadQuality(thread);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("thread.first-tweet-numbering");
    expect(codes).toContain("thread.first-tweet-summary-tone");
  });

  it("flags missing executable tweet for abstract framework content", () => {
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: [
        "**判断：** 框架思维比技巧更重要。",
        "**观点一：** 系统比技巧更稳。",
        "**观点二：** 长期主义带来复利。",
        "**观点三：** 选择优于努力。",
        "**观点四：** 框架比内容更重要。",
        "**观点五：** 思维优于行动。",
        "请回复你最认同的一条。",
      ],
    };
    const issues = checkThreadQuality(thread, {
      sourceText: ABSTRACT_FRAMEWORK_FIXTURE.structuredNotesMd,
    });
    expect(issues.map((i) => i.code)).toContain("thread.no-executable-tweet");
  });

  it("flags missing risk tweet for high-trust topic", () => {
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: [
        "**外区 Apple ID 最稳的路径：** 提前对齐网络、设备、支付。",
        "**网络一致性：** 全程使用同一个外区出口 IP。",
        "**邮箱准备：** 使用未注册过的邮箱。",
        "**支付方式：** 用礼品卡充值，不绑定信用卡。",
        "**可执行模板：** 我整理了一份注册前最小检查清单，可直接复制。",
        "**步骤验证：** 重新登录确认 Storefront 已切换。",
        "回复你目前卡在哪一步，我帮你拆出下一步动作。",
      ],
    };
    const issues = checkThreadQuality(thread, {
      sourceText: HIGH_TRUST_FIXTURE.structuredNotesMd,
    });
    expect(issues.map((i) => i.code)).toContain("thread.missing-risk-tweet");
  });

  it("flags author phrase", () => {
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: [
        "**视频作者说：** 这是首推",
        ...GOOD_THREAD.tweets.slice(1),
      ],
    };
    const issues = checkThreadQuality(thread);
    expect(issues.map((i) => i.code)).toContain("thread.author-phrase");
  });

  it("flags overly long tweet", () => {
    const longTweet = "句子".repeat(300);
    const thread: GeneratedThread = {
      ...GOOD_THREAD,
      tweets: [GOOD_THREAD.tweets[0]!, longTweet, ...GOOD_THREAD.tweets.slice(2)],
    };
    const issues = checkThreadQuality(thread);
    expect(issues.map((i) => i.code)).toContain("thread.tweet-too-long");
  });
});

describe("formatQualityIssues", () => {
  it("returns empty string for empty input", () => {
    expect(formatQualityIssues([])).toBe("");
  });

  it("renders issues into bullet lines with severity and code", () => {
    const out = formatQualityIssues([
      {
        code: "article.lead-too-long",
        severity: "warning",
        message: "Lead 太长",
        detail: "lead=180",
      },
    ]);
    expect(out).toBe("- [warning] article.lead-too-long: Lead 太长 (lead=180)");
  });
});
