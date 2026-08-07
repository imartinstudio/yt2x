/**
 * 跨 prompt 共享规则 — 消除 article/thread/short/deconstruct/clip-post/platform 之间
 * ~30-40% 的重复 system prompt 文本，每次调用节省 ~300-1500 tokens。
 *
 * 使用方式：每个 generator 的 system prompt 从 `${SHARED_BASE} + 特定规则` 组合。
 */

/** 所有文章、帖子、介绍和 JSON 字段共用的术语保护规则。 */
export const SHARED_TECHNICAL_TERMS = `专业术语保护（适用于所有文章、帖子、标题、摘要、介绍、标签、时间线、视觉说明和 JSON 字段）：
- 源材料中的技术专有名词、方法名、框架名、模型名、产品名、命令、API 名、代码标识和可复制英文 prompt，必须按原文逐字保留，不得翻译、音译或本地化。尤其是 Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph；如果它们出现在源材料中，输出必须保留对应英文拼写。
- 当「图」在源材料中表示 graph 概念时，必须写成 Graph，不得只写中文「图」。例如「图的基本词汇」写成「Graph 的基本词汇」、「什么时候值得用图」写成「什么时候值得用 Graph」、「三个可直接套用的现成图」写成「三个可直接套用的现成 Graph」、「更大的图不等于更好的产出」写成「更大的 Graph 不等于更好的产出」、「构建你的第一个图」写成「构建你的第一个 Graph」。
- Knowledge Graph 和 Agent Graph 必须保持英文；例如「知识图谱 vs 代理图谱」应写成「Knowledge Graph vs Agent Graph」。可以追加中文解释，但不得用「提示工程」「上下文工程」「图工程」「知识图谱」「代理图谱」替换英文术语，也不得凭空加入源材料没有的术语。`;

/** 语言：全文统一使用简体中文（硬性要求，不可违反） */
export const SHARED_LANG_ZH_CN = [
  "全文必须使用简体中文（zh-CN）。禁止输出繁体中文。如果你不确定某个字是简体还是繁体，选择简体。原始材料中的普通英文、繁体中文、日文等其他语言必须翻译或转写为自然简体中文。这是硬性要求，不可违反。",
  SHARED_TECHNICAL_TERMS,
].join("\n");

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
