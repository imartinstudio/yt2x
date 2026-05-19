import type { VisualSuggestionKind } from "./types.js";

/**
 * 视觉建议（visual suggestion）数据结构与推导函数。
 *
 * 这些建议描述「这篇 article 应该生成 / 选用什么样的图」，不强制写入 Markdown 图片引用。
 * 当没有真实截图文件时，CLI 会把建议写到 `visual-suggestions.json`，供后续手动制图或图表生成器使用。
 */

export type VisualSuggestionPriority = "high" | "medium" | "low";

export type VisualSuggestion = {
  /** 视觉类型。 */
  kind: VisualSuggestionKind;
  /** 目标小节标题（去掉 `##` 前缀与加粗标记），用于人类对照。 */
  target_section: string;
  /** 应当生成的图的人类可读描述。 */
  description: string;
  /** 优先级；high 表示「该小节强烈需要可视化」。 */
  priority: VisualSuggestionPriority;
  /** 推断出该建议的触发关键词。 */
  trigger: string;
};

const stripBoldMarkers = (text: string): string =>
  text.replace(/\*\*/g, "").trim();

const collectArticleSections = (
  content: string,
): Array<{ heading: string; body: string }> => {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading: string | null = null;
  let currentBody: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (currentHeading === null) return;
    sections.push({
      heading: currentHeading,
      body: currentBody.join("\n").trim(),
    });
    currentHeading = null;
    currentBody = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (currentHeading !== null) currentBody.push(line);
      continue;
    }
    if (!inFence && line.startsWith("## ")) {
      flush();
      currentHeading = stripBoldMarkers(line.slice(3).trim());
      continue;
    }
    if (currentHeading !== null) currentBody.push(line);
  }
  flush();
  return sections;
};

const HEADING_TRIGGERS: ReadonlyArray<{
  re: RegExp;
  kind: VisualSuggestionKind;
  priority: VisualSuggestionPriority;
  description: (heading: string) => string;
}> = [
  {
    re: /(对比|比较|误区|正确做法|错误做法|vs|对照)/i,
    kind: "comparison",
    priority: "high",
    description: (heading) =>
      `建议在小节「${heading}」插入对比图：左侧呈现常见错误做法，右侧呈现推荐做法，并标出关键差异点。`,
  },
  {
    re: /(流程|步骤|路径|管道|pipeline|workflow)/i,
    kind: "diagram",
    priority: "high",
    description: (heading) =>
      `建议在小节「${heading}」插入流程图：用节点 + 箭头表达「输入 → 处理 → 验证 → 输出」式步骤，避免散文堆叠。`,
  },
  {
    re: /(层级|架构|结构|系统|框架)/i,
    kind: "diagram",
    priority: "medium",
    description: (heading) =>
      `建议在小节「${heading}」插入层级图：用父概念 → 子能力 → 落地动作的层级结构表达。`,
  },
  {
    re: /(模板|template|清单|checklist|检查)/i,
    kind: "template-card",
    priority: "medium",
    description: (heading) =>
      `建议在小节「${heading}」生成一张「模板卡片」：把可复制资产以卡片形式排版，方便读者截图保存。`,
  },
  {
    re: /(配置|命令|界面|输出|验证|演示|操作)/i,
    kind: "ui-screenshot",
    priority: "medium",
    description: (heading) =>
      `建议在小节「${heading}」补一张 UI 截图：展示真实配置界面、命令输出或验证结果，提升可信度。`,
  },
  {
    re: /(风险|边界|后果|失败)/i,
    kind: "comparison",
    priority: "medium",
    description: (heading) =>
      `建议在小节「${heading}」用 ⚠️ 风险卡片样式排版：列出最坏后果、触发条件、规避动作，便于读者扫描。`,
  },
];

/**
 * 从 Article Markdown 推导出视觉建议。
 *
 * 简单启发式：根据小节标题命中的关键词决定建议类型。
 * 调用方可结合 available_visuals 与已插入图片的情况决定是否把建议写入磁盘。
 */
export const deriveArticleVisualSuggestions = (
  articleMd: string,
): VisualSuggestion[] => {
  const sections = collectArticleSections(articleMd);
  const out: VisualSuggestion[] = [];
  const seenSections = new Set<string>();

  for (const section of sections) {
    if (seenSections.has(section.heading)) continue;
    for (const trigger of HEADING_TRIGGERS) {
      const m = section.heading.match(trigger.re);
      if (m === null) continue;
      out.push({
        kind: trigger.kind,
        target_section: section.heading,
        description: trigger.description(section.heading),
        priority: trigger.priority,
        trigger: m[0],
      });
      seenSections.add(section.heading);
      break;
    }
  }

  return out;
};

/**
 * 选择 article 封面：在候选文件名数组中按规则挑出最合适的一张。
 *
 * 规则（按优先级降序）：
 * 1. `youtube_cover.*` —— YouTube 官方封面，永远最优先。
 * 2. 非 `contact_sheet.*` 的任意截图 —— 通常是关键帧。
 * 3. `contact_sheet.*` —— 拼图缩略，最低优先级，仅在没有任何其他图时使用。
 *
 * 输入：候选文件名数组（不含目录），返回选中的文件名；候选为空时返回 null。
 */
export const pickArticleCoverFromCandidates = (
  candidates: readonly string[],
): string | null => {
  if (candidates.length === 0) return null;
  const youtubeCover = candidates.find((n) => n.toLowerCase().startsWith("youtube_cover."));
  if (youtubeCover !== undefined) return youtubeCover;
  const nonContactSheet = candidates.find(
    (n) => !n.toLowerCase().startsWith("contact_sheet."),
  );
  if (nonContactSheet !== undefined) return nonContactSheet;
  return candidates[0] ?? null;
};
