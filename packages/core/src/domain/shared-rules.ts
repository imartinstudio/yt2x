/**
 * 跨 prompt 共享规则 — 消除 article/thread/short/deconstruct/clip-post/platform 之间
 * ~30-40% 的重复 system prompt 文本，每次调用节省 ~300-1500 tokens。
 *
 * 使用方式：每个 generator 的 system prompt 从 `${SHARED_BASE} + 特定规则` 组合。
 */

/** 语言：全文统一使用简体中文 */
export const SHARED_LANG_ZH_CN =
  "全文统一使用简体中文（zh-CN）；如果原始标题、字幕、笔记或引用材料是英文、繁体中文、日文等其他语言，必须翻译或转写为自然简体中文。技术专有名词、命令、API 名、品牌名和可复制英文 prompt 可保留英文。";

/** 事实约束：不得编造 */
export const SHARED_NO_FABRICATION =
  "不要编造输入材料中没有的事实、数据、人物、产品能力或来源信息，也不得编造官方链接、价格、承诺或「官方认可」「永久有效」「百分百成功」等无来源保证。";

/** 禁止引用视频作者 */
export const SHARED_NO_VIDEO_AUTHOR = "不要出现「视频作者」字样。";

/** JSON 输出约束 */
export const SHARED_JSON_OUTPUT =
  "只输出严格 JSON，不要用 Markdown 代码围栏包裹 JSON，不要输出解释性前后缀。";

/** 禁止廉价标题党 */
export const SHARED_NO_CLICKBAIT =
  "不要廉价标题党，不要夸大原材料没有支持的结论。";

/** 高信任风险规则（共享段落） */
export const SHARED_HIGH_TRUST_RISK = `当主题涉及账号注册、外区账号、封号、风控、付款、礼品卡、充值、订阅、退款、第三方购买渠道、OAuth、API key、token、cookies、浏览器凭证、自动发布、自动删除、自动部署等高信任成本场景时，必须包含独立风险说明。
风险说明必须如实写出最坏后果，例如账号锁定、充值失败、资金损失、凭证泄露、操作不可逆。
不得弱化后果，不得编造「官方认可」「永久有效」「百分百成功」等无来源保证。`;

/** X 平台基础规则集（article/thread/short 共用） */
export const SHARED_X_BASE = [
  SHARED_LANG_ZH_CN,
  SHARED_NO_FABRICATION,
  SHARED_NO_VIDEO_AUTHOR,
  SHARED_NO_CLICKBAIT,
].join("\n");

/** JSON 输出规则集（thread/short/deconstruct/clip-post 共用） */
export const SHARED_JSON_BASE = [
  SHARED_LANG_ZH_CN,
  SHARED_NO_FABRICATION,
  SHARED_JSON_OUTPUT,
].join("\n");
