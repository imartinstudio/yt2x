import type { ContentQualityFixture } from "./types.js";

/**
 * 内容质量 fixture：用于 prompt 单测与 deterministic check 测试。
 *
 * 约束（与 AGENTS.md 一致）：
 * - id / title / URL 均为占位符或脱敏值，禁止真实 YouTube 视频 ID。
 * - 不出现真实 API key、OAuth token、cookies、浏览器凭证或下载产物。
 * - structuredNotesMd 信息密度尽量接近真实生成，但内容均为可公开示例。
 */

const ACCOUNT_REGION_NOTES = `# 外区 Apple ID 申请与日常维护

Source: <YOUTUBE_URL>
Original title: <脱敏原始标题>
Thumbnail: youtube_cover.jpg
Transcript source: manual captions
Screenshot source: captured keyframes
Processed: 2026-05-18

## Executive Summary
本视频讲解如何安全申请外区 Apple ID、绑定支付方式、领取免费应用，并避免被苹果风控判定异常导致账号锁定。

## Topic Outline
1. 外区账号收益与风险 - 哪些 App 只能在外区下载，账号被风控会带来什么后果
2. 注册前准备 - 邮箱、地址、电话号码、网络环境
3. 正式注册步骤 - 设置外区 App Store 国家 / 区域、新建 Apple ID
4. 支付方式与礼品卡 - 不绑定信用卡的安全做法
5. 日常使用与避免封号 - 切换区域频率、设备登录数量、IP 一致性

## Detailed Notes
### 外区账号收益与风险
- 部分 App、订阅、AI 工具只在美区或日区上架，国区账号无法访问。
- 苹果风控会扫描登录 IP、设备、支付来源、登录频率等多个信号。
- 一旦被判定异常，最坏情况是账号锁定 24 小时甚至永久封禁，余额无法找回。

### 注册前准备
- 准备一个未注册过 Apple ID 的邮箱。
- 准备一个真实可控的外区收件地址，区号要匹配。
- 切到一个稳定的外区出口 IP，不要在注册过程中切换网络。
- 退出当前所有 Apple ID，避免历史登录记录被关联。

### 正式注册步骤
1. 在 iPhone 设置中切换 App Store 国家 / 区域为目标外区。
2. 同意条款，填写邮箱、密码、出生日期、安全问题。
3. 在「付款方式」处选择「无 / None」，跳过信用卡绑定。
4. 接收邮箱验证码，完成激活。
5. 重新登录 App Store 检查 Storefront 是否切换成功。

### 支付方式与礼品卡
- 推荐先用礼品卡为账号充值，再绑定订阅服务。
- 礼品卡只在原区有效，购买前要确认面额币种。
- 退款必须走 reportaproblem.apple.com，不接受私下渠道。

### 日常使用与避免封号
- 不要在 24 小时内频繁切换 Apple ID 或区域。
- 同一台设备登录的 Apple ID 数量越少越安全。
- 自动续订与家庭共享必须使用同一区账号，跨区切换会被风控。

## Key Takeaways
- 外区 Apple ID 的核心风险不是被苹果发现，而是后续支付与订阅时被风控。
- 不绑定信用卡 + 礼品卡充值是最稳的支付路径。
- 一旦账号锁定，余额、订阅、家庭共享都可能失效。

## Risk
- Apple ID 被永久封禁后，礼品卡余额、已购内容、订阅都无法恢复。
- 使用代抢、共享、出售账号属于违反 Apple 服务条款的行为。

## Reusable Prompts
\`\`\`text
帮我整理一份外区 Apple ID 申请前的检查清单，包括：
- 邮箱、地址、电话号码、网络要求
- 注册过程中不能做的事
- 风险与适用边界
\`\`\`
`;

const CLAUDE_SKILLS_NOTES = `# Claude Skills 工作流：把高质量提示词系统化

Source: <YOUTUBE_URL>
Original title: <脱敏原始标题>
Thumbnail: youtube_cover.jpg
Transcript source: manual captions
Screenshot source: not captured
Processed: 2026-05-18

## Executive Summary
本视频讨论如何把零散的「调好用」的 prompt 整理成可复用、可分发、可演进的 Claude Skill 资产，覆盖结构、命名、触发条件、版本控制和评估方法。

## Topic Outline
1. Skill 与 Prompt 的区别 - 单条 prompt vs 可触发、可组合的 Skill
2. Skill 结构 - SKILL.md 必备字段、附属文件、依赖描述
3. 触发条件设计 - 什么样的 description 能稳定召回
4. 版本与评估 - 如何避免「越改越差」
5. 多 Skill 协作 - Skill 之间的边界与冲突

## Detailed Notes
### Skill 与 Prompt 的区别
- 单条 prompt 是一次性的输入，没有触发条件与上下文边界。
- Skill 通过 description 被 Agent 自动召回，本质是「带元数据的 prompt 包」。
- 区别在于：是否可被发现、是否可被组合、是否可被维护。

### Skill 结构
- SKILL.md 必备字段：name、description、入口指令。
- 附属文件：模板、示例、关键决策树、必要的脱敏数据。
- 不要把不可复用的私有信息写进 Skill，敏感数据放到本地配置。

### 触发条件设计
- description 必须能被 LLM 与人同时读懂。
- 写 description 时回答三个问题：什么时候用、什么时候不用、典型触发关键词。
- 避免在 description 中出现工具名或品牌名，否则容易让召回失真。

### 版本与评估
1. 每次修改前先记录当前 Skill 在固定测试集上的表现。
2. 修改后跑同一份测试集，比较召回率、误触率、输出质量。
3. 把对比结果写到 Skill 自身的 changelog 中，不要靠记忆。

### 多 Skill 协作
- 同一领域多个 Skill 时，必须明确边界，避免相互覆盖。
- 复杂任务推荐拆成多个小 Skill，由一个 Orchestrator Skill 调用。
- Skill 之间的依赖应通过文本说明，而不是隐式假设。

## Key Takeaways
- Skill 的本质是「可被发现的 prompt」，description 决定一切。
- 没有评估的 Skill 不可信，先固化测试集再迭代。
- 复杂工作流要切成多 Skill 组合，而不是写一个超大 Skill。

## Reusable Prompts
\`\`\`text
请帮我把这段 prompt 改写成一个 Claude Skill 包，要求：
- description 写清楚什么时候触发、什么时候不触发
- 列出必要的附属文件清单
- 给出一个最小评估测试集
\`\`\`
`;

const YT_DLP_NOTES = `# yt-dlp 进阶用法：稳定下载 YouTube 字幕与封面

Source: <YOUTUBE_URL>
Original title: <脱敏原始标题>
Thumbnail: youtube_cover.jpg
Transcript source: manual captions
Screenshot source: captured keyframes
Processed: 2026-05-18

## Executive Summary
本视频介绍如何用 yt-dlp 一次性拿到 YouTube 视频的元数据、字幕、缩略图和音频，并避免常见的 429、人机验证、字幕缺失问题。

## Topic Outline
1. 安装与版本管理 - pipx / brew / 自动更新
2. 元数据与字幕一次性获取 - 常用组合参数
3. 字幕语言回退 - 自动字幕 vs 手动字幕
4. 频率限制与 Cookies - 出错时的诊断顺序
5. 与 ffmpeg 联动 - 关键帧、音频转码

## Detailed Notes
### 安装与版本管理
- 推荐用 pipx 安装，便于在多 Python 环境下统一更新。
- 长期跑批量任务必须开启自动更新，否则会因为 YouTube 接口变化而失败。

### 元数据与字幕一次性获取
- 常用参数组合：\`--write-info-json --write-subs --write-thumbnail\`。
- 字幕格式优先 vtt，便于后续按时间切片。
- 缩略图自动保存为 webp，需要 jpg 时配合 ffmpeg 转码。

### 字幕语言回退
1. 先尝试手动字幕：\`--sub-langs zh-Hans,en\`。
2. 找不到手动字幕时回退自动字幕：\`--write-auto-subs\`。
3. 如果都没有，记录到日志并跳过，不要重复请求。

### 频率限制与 Cookies
- 429 错误说明触发了频率限制，应等待几分钟再继续。
- 触发人机验证或年龄限制时，使用 \`--cookies-from-browser chrome\`。
- 不要把导出的 cookies 文件提交到仓库，避免凭证泄露。

### 与 ffmpeg 联动
- yt-dlp 自身不做关键帧抽取，需要调用 ffmpeg。
- 音频提取推荐 m4a，质量与体积折中较好。
- 长视频建议先抽帧再做内容分析，避免一次加载全量画面。

## Key Takeaways
- yt-dlp 的批量稳定性 80% 取决于版本与网络，20% 取决于参数。
- 缩略图与字幕都应该明确指定格式，不要依赖默认行为。
- 触发风控时优先用浏览器 cookies + 适度等待，不要无脑重试。
`;

export const HIGH_TRUST_FIXTURE: ContentQualityFixture = {
  id: "fx-account-region",
  category: "high-trust-tutorial",
  description:
    "外区 Apple ID 申请与维护：高信任成本主题，需要独立风险/边界小节与可执行清单。",
  metadata: {
    id: "fx-account-region",
    title: "外区 Apple ID 申请与日常维护",
    webpage_url: "<YOUTUBE_URL>",
  },
  structuredNotesMd: ACCOUNT_REGION_NOTES,
  expectations: {
    article: {
      hookElements: ["pain", "loss", "gain"],
      requiresRiskSection: true,
      highTrustTopics: ["account", "payment"],
      executableAssetKinds: ["checklist", "steps", "risk-list", "prompt"],
      visualNeed: "ui-screenshot",
    },
    short: {
      hookElements: ["contrast", "loss"],
      requiresRiskSection: true,
      highTrustTopics: ["account", "payment"],
      executableAssetKinds: ["checklist", "risk-list"],
      visualNeed: "ui-screenshot",
    },
    thread: {
      hookElements: ["pain", "loss", "gain"],
      requiresRiskSection: true,
      highTrustTopics: ["account", "payment"],
      executableAssetKinds: ["checklist", "steps", "risk-list"],
      visualNeed: "ui-screenshot",
    },
  },
};

export const ABSTRACT_FRAMEWORK_FIXTURE: ContentQualityFixture = {
  id: "fx-claude-skills",
  category: "abstract-framework",
  description:
    "Claude Skills 工作流：抽象框架类内容，主要需要对比/层级类视觉建议和模板/决策树资产。",
  metadata: {
    id: "fx-claude-skills",
    title: "Claude Skills 工作流：把高质量 Prompt 系统化",
    webpage_url: "<YOUTUBE_URL>",
  },
  structuredNotesMd: CLAUDE_SKILLS_NOTES,
  expectations: {
    article: {
      hookElements: ["contrast", "gain"],
      requiresRiskSection: false,
      highTrustTopics: [],
      executableAssetKinds: ["template", "checklist", "prompt"],
      visualNeed: "diagram",
    },
    short: {
      hookElements: ["contrast", "gain"],
      requiresRiskSection: false,
      highTrustTopics: [],
      executableAssetKinds: ["template", "checklist"],
      visualNeed: "comparison",
    },
    thread: {
      hookElements: ["contrast", "gain"],
      requiresRiskSection: false,
      highTrustTopics: [],
      executableAssetKinds: ["template", "checklist", "steps"],
      visualNeed: "diagram",
    },
  },
};

export const GENERAL_TOOL_FIXTURE: ContentQualityFixture = {
  id: "fx-yt-dlp",
  category: "general-tool-tutorial",
  description:
    "yt-dlp 进阶用法：普通工具教程，需要命令/步骤等可执行资产，UI 截图为佳。",
  metadata: {
    id: "fx-yt-dlp",
    title: "yt-dlp 进阶用法：稳定下载 YouTube 字幕与封面",
    webpage_url: "<YOUTUBE_URL>",
  },
  structuredNotesMd: YT_DLP_NOTES,
  expectations: {
    article: {
      hookElements: ["pain", "gain"],
      requiresRiskSection: false,
      highTrustTopics: [],
      executableAssetKinds: ["steps", "checklist"],
      visualNeed: "ui-screenshot",
    },
    short: {
      hookElements: ["pain", "gain"],
      requiresRiskSection: false,
      highTrustTopics: [],
      executableAssetKinds: ["steps"],
      visualNeed: "ui-screenshot",
    },
    thread: {
      hookElements: ["pain", "gain"],
      requiresRiskSection: false,
      highTrustTopics: [],
      executableAssetKinds: ["steps", "checklist"],
      visualNeed: "ui-screenshot",
    },
  },
};

/** 所有内置 fixture 列表。 */
export const CONTENT_QUALITY_FIXTURES: readonly ContentQualityFixture[] = [
  HIGH_TRUST_FIXTURE,
  ABSTRACT_FRAMEWORK_FIXTURE,
  GENERAL_TOOL_FIXTURE,
];
