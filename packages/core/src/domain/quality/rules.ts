import type { ExecutableAssetKind, HighTrustTopic } from "./types.js";

/**
 * 跨目标共用的内容质量规则常量。
 *
 * 这些常量同时被 prompt 文案、确定性检查和测试 fixture 引用，以保证「规则」只在一处定义。
 */

/** 导语硬上限（汉字/字符），超过则判为不合格。 */
export const ARTICLE_LEAD_MAX_CHARS = 120;

/** 长段落上限（汉字/字符），超过则视为「连续超长段落」。 */
export const ARTICLE_PARAGRAPH_MAX_CHARS = 250;

/** Article 同一小节最多连续正文段数，超过必须用列表/引用/代码块/分隔等视觉锚点拆分。 */
export const ARTICLE_MAX_CONSECUTIVE_PARAGRAPHS = 2;

/** Short list item 数量区间（含）。 */
export const SHORT_LIST_MIN_ITEMS = 4;
export const SHORT_LIST_MAX_ITEMS = 6;

/** Thread tweet 数量区间（含）。 */
export const THREAD_MIN_TWEETS = 6;
export const THREAD_MAX_TWEETS = 10;

/** Thread 单条 tweet 最大字符数，与发布层一致。 */
export const THREAD_TWEET_MAX_CHARS = 500;

/**
 * 高信任成本主题检测关键字。
 *
 * 这些关键字命中即视为对应主题，需要触发风险/边界小节。匹配大小写不敏感、
 * 中英文 token 直接子串匹配（适用于 metadata.title 与 structured-notes 全文）。
 */
export const HIGH_TRUST_TOPIC_KEYWORDS: Record<HighTrustTopic, readonly string[]> = {
  account: [
    "apple id",
    "appleid",
    "外区",
    "外区账号",
    "账号注册",
    "封号",
    "风控",
    "实名",
    "解封",
  ],
  payment: [
    "礼品卡",
    "充值",
    "付款",
    "支付",
    "退款",
    "退订",
    "订阅",
    "信用卡",
    "gift card",
    "billing",
    "refund",
  ],
  credentials: [
    "api key",
    "oauth",
    "token",
    "cookies",
    "cookie",
    "credential",
    "凭证",
    "授权",
    "私钥",
  ],
  automation: [
    "自动发布",
    "自动发帖",
    "自动删除",
    "批量删除",
    "自动部署",
    "自动发送",
    "auto-publish",
    "auto-post",
  ],
};

/**
 * Short / Article / Thread 共用的「摘要腔」开头禁用片段。
 *
 * 命中即视为不合格 hook，会在 deterministic check 中报警。
 */
export const SUMMARY_TONE_PHRASES: readonly string[] = [
  "本视频介绍",
  "本视频讲了",
  "本视频讲述",
  "本视频分享",
  "本期视频",
  "在本视频中",
  "本文介绍",
  "本文讲述",
  "本文分享",
  "总结一下",
  "近年来",
  "随着",
];

/** 视频作者腔禁用词。Article / Short / Thread 都禁止出现「视频作者」。 */
export const FORBIDDEN_AUTHOR_PHRASES: readonly string[] = ["视频作者"];

/**
 * 可执行资产信号：在正文中匹配到任一即视为命中。
 *
 * - prompt：fenced code block，且块内文本含「prompt」或形如指令的多行内容。
 * - template / checklist / steps / risk-list / decision-tree：根据出现的小标题或语义提示判断。
 */
export const EXECUTABLE_ASSET_KEYWORDS: Record<ExecutableAssetKind, readonly string[]> = {
  prompt: ["prompt", "提示词", "system prompt"],
  template: ["模板", "template", "示例文案"],
  checklist: ["检查清单", "清单", "checklist", "todo"],
  steps: ["步骤", "操作步骤", "流程"],
  "risk-list": ["风险清单", "风险与", "风险提示", "适用边界"],
  "decision-tree": ["决策树", "决策表", "判断流程"],
};

/** 风险小节命中关键字（Article）。 */
export const RISK_SECTION_KEYWORDS: readonly string[] = [
  "风险",
  "边界",
  "适用边界",
  "适用范围",
  "注意事项",
];

/** 串推首推禁用前缀，例如「1/」「1）」「1.」开头容易让首条变成串推编号化解释。 */
export const THREAD_FIRST_TWEET_FORBIDDEN_PREFIXES: readonly string[] = [
  "1/",
  "1）",
  "1）",
  "本视频",
  "本文",
];

/**
 * 用大小写不敏感的子串匹配判断某段文本是否命中关键字集合。
 *
 * 纯函数，便于单测。
 */
export const matchesAny = (
  haystack: string,
  needles: readonly string[],
): boolean => {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
};

/**
 * 检测文本命中的高信任主题列表。
 *
 * 输入应是 metadata.title + structured-notes 等综合文本；返回去重后的命中主题数组。
 */
export const detectHighTrustTopics = (text: string): HighTrustTopic[] => {
  const lower = text.toLowerCase();
  const hits: HighTrustTopic[] = [];
  for (const [topic, keywords] of Object.entries(HIGH_TRUST_TOPIC_KEYWORDS) as Array<
    [HighTrustTopic, readonly string[]]
  >) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) {
      hits.push(topic);
    }
  }
  return hits;
};
