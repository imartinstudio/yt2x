import { stripHeavyMetadata } from "../notes/prompts.js";
import type { VideoShortPromptInput, VideoShortPromptOptions } from "./types.js";

export const VIDEO_SHORT_X_SYSTEM_PROMPT = `你是 X (Twitter) 上的技术创作者。为短视频写 caption。

## 核心原则
- 不要写成功能介绍。不要写教程目录。不要写产品说明书。
- 写成一个发现、一个意外、一个认知被打破的瞬间。
- 优先使用三种结构之一：
  A. 冲突 → 真实场景 → 个人感受
  B. 错误认知 → 实际发现 → 结论
  C. 问题 → 测试 → 结果

## 结构要求
- 钩子（1-2 句，必须有冲突或反差）
- 核心观点提炼（2-4 个关键点，包含具体数字或对比）
- 总结/价值（读者看完获得的明确结果）
- 三部分之间必须有空行
- 整体 4-7 行，60-120 字

## Emoji 规则
- 每条 0–1 个 Emoji，最多 2 个
- Emoji 必须和前后句有逻辑关系
- 禁止固定模板式 emoji

## 去 AI 味规则
删除：效率提升、赋能、革命性、颠覆、降本增效
替换为：我以为… / 结果… / 最震撼的是… / 我差点…

## 结尾
必须在总结部分之后空一行，追加「完整视频+中文字幕：👇」
只基于提供的 metadata 和 structured notes，不编造事实或链接
全文统一使用简体中文（zh-CN）

## 输出
只输出严格 JSON：{"text": "<说明文字，含结尾 footer>"}`;

export const buildVideoShortUserPrompt = (
  input: VideoShortPromptInput,
  options: VideoShortPromptOptions = {},
): string => {
  const platform = options.platform ?? "x";
  if (platform !== "x") {
    throw new Error(`Unsupported video short platform: ${String(platform)}`);
  }

  const meta = stripHeavyMetadata(input.metadata);
  const sections: string[] = [];
  sections.push("## Video metadata (JSON)");
  sections.push("```json");
  sections.push(JSON.stringify(meta, null, 2));
  sections.push("```");

  sections.push("");
  sections.push("## Structured notes (Markdown source)");
  sections.push("");
  sections.push(input.structuredNotesMd.trim());
  sections.push("");
  sections.push(
    "Generate the video short caption JSON in Simplified Chinese (zh-CN). Translate Traditional Chinese and all non-Chinese source material into Simplified Chinese. Output strict JSON only.",
  );
  return sections.join("\n");
};
