import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeconstructManifest } from "@yt2x/core";

/** 将秒数格式化为 MM:SS 或 H:MM:SS */
const fmtTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/** 角度 → 中文标签 */
const angleLabel = (a: string): string => {
  const map: Record<string, string> = {
    contrarian: "反直觉 💥",
    practical: "实用 ✅",
    warning: "风险 ⚠️",
    tutorial: "教程 📖",
    intro: "引言 🎬",
    outro: "结尾 🏁",
    discussion: "讨论 💬",
  };
  return map[a] ?? a;
};

/** 评分 → 星星 */
const stars = (n: number): string => "⭐".repeat(Math.round(n));

// ═══════════════════════════════════════════
// DECOMPOSITION 报告
// ═══════════════════════════════════════════

export const generateDecompositionReport = (
  manifest: DeconstructManifest,
  articleTitle?: string,
): string => {
  const lines: string[] = [];
  const src = manifest.source;

  lines.push(`# 《${articleTitle ?? src.videoId}》章节拆解报告`);
  lines.push(`> 生成时间: ${new Date(manifest.generatedAt).toLocaleString("zh-CN")}`);
  lines.push(`> 来源视频: ${src.videoId} (${Math.round(src.durationSec / 60)}min)`);
  const origCount = manifest.candidateCount;
  const selCount = manifest.total ?? manifest.clips.length;
  lines.push(`> 原始候选: ${origCount} 个 → 已选中: ${selCount} 个`);
  if (origCount !== selCount) {
    lines.push(`> （${origCount - selCount} 个低分候选已自动过滤）`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // 章节完整清单
  const selected = manifest.clips.filter((c) => c.selected);
  if (selected.length > 0) {
    lines.push("## ✅ 已选中章节");
    lines.push("");
    lines.push("| # | 章节 | 时段 | 长度 | 类型 | 综合评分 |");
    lines.push("|---|------|------|------|------|---------|");
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i]!;
      lines.push(
        `| ${String(i + 1).padStart(2)} | **${c.title}** ` +
        `| ${fmtTime(c.timecodes.startSec)}-${fmtTime(c.timecodes.endSec)} ` +
        `| ${Math.round(c.timecodes.durationSec)}s ` +
        `| ${angleLabel(c.angle)} ` +
        `| ${c.scores ? `${stars(c.scores.composite)} ${c.scores.composite.toFixed(1)}` : "-"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 📋 完整章节清单");
  lines.push("");
  lines.push(`共识别 **${manifest.candidateCount} 个独立章节单元**。`);
  lines.push("");

  lines.push("| # | 章节 | 时段 | 长度 | 类型 | 综合评分 | 金句/摘要 |");
  lines.push("|---|------|------|------|------|---------|----------|");
  for (let i = 0; i < manifest.clips.length; i++) {
    const c = manifest.clips[i]!;
    const sel = c.selected ? "**" : "";
    const dur = Math.round(c.timecodes.durationSec);
    lines.push(
      `| ${String(i + 1).padStart(2)} | ${sel}${c.title}${sel} ` +
      `| ${fmtTime(c.timecodes.startSec)}-${fmtTime(c.timecodes.endSec)} ` +
      `| ${dur}s ` +
      `| ${angleLabel(c.angle)} ` +
      `| ${c.scores ? `${stars(c.scores.composite)} ${c.scores.composite.toFixed(1)}` : "-"} ` +
      `| ${c.articleSection ?? ""} |`,
    );
  }
  lines.push("");

  // 评分排序
  if (manifest.clips.length > 0) {
    lines.push("## 📊 综合评分排序");
    lines.push("");
    lines.push("| 排名 | 章节 | 反直觉 | 传播力 | 实操收益 | 表现力 | 综合 |");
    lines.push("|------|------|:------:|:------:|:--------:|:------:|:----:|");

    const sorted = [...manifest.clips]
      .filter((c) => c.scores)
      .sort((a, b) => (b.scores?.composite ?? 0) - (a.scores?.composite ?? 0));

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!;
      const s = c.scores!;
      lines.push(
        `| ${i + 1} | ${c.title} ` +
        `| ${s.counter_intuitiveness}/5 ` +
        `| ${s.shareability}/5 ` +
        `| ${s.practical_value}/5 ` +
        `| ${s.visual_appeal}/5 ` +
        `| **${s.composite.toFixed(1)}** |`,
      );
    }
    lines.push("");
  }

  // 视频文件状态
  lines.push("## 🎬 视频文件");
  lines.push("");
  for (const c of manifest.clips) {
    const dur = Math.round(c.timecodes.durationSec);
    const sel = c.selected ? "✅ 已选中" : "⬜ 候选";
    lines.push(`- \`${c.video}\` (${dur}s) — ${sel}`);
  }
  lines.push("");

  // 发布顺序建议
  const posted = manifest.clips.filter((c) => c.selected);
  if (posted.length > 0) {
    lines.push("## 📅 建议发布顺序");
    lines.push("");
    lines.push("| 天 | 帖子 | 视频 | 策略 |");
    lines.push("|---|------|------|------|");

    const _firstLine = posted[0]!;
    const _lastLine = posted[posted.length - 1]!;

    // 把最有冲击力的放第一天，最提纲的放最后
    const reorder = [...posted];
    const highestScore = [...posted].sort(
      (a, b) => (b.scores?.composite ?? 0) - (a.scores?.composite ?? 0),
    )[0];
    if (highestScore && highestScore !== reorder[0]) {
      // Move highest score to position 1
      const idx = reorder.indexOf(highestScore);
      reorder.splice(idx, 1);
      reorder.unshift(highestScore);
    }

    for (let i = 0; i < reorder.length; i++) {
      const c = reorder[i]!;
      const strategy = i === 0
        ? "首发 — 最有冲击力"
        : i === reorder.length - 1
          ? "收尾 — 引流完整文章"
          : "日常 — 维持热度";
      lines.push(
        `| Day ${i + 1} | ${c.title} | ${c.video} (${Math.round(c.timecodes.durationSec)}s) | ${strategy} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

// ═══════════════════════════════════════════
// PROFESSIONAL REVIEW 报告
// ═══════════════════════════════════════════

export const generateProfessionalReview = (
  manifest: DeconstructManifest,
  articleTitle?: string,
): string => {
  const lines: string[] = [];
  const selected = manifest.clips.filter((c) => c.selected && c.text);

  lines.push(`# X 运营审核报告：${articleTitle ?? manifest.source.videoId}`);
  lines.push(`> 生成时间: ${new Date(manifest.generatedAt).toLocaleString("zh-CN")}`);
  lines.push(`> 分析维度: 钩子质量 / 信息密度 / 文视配合 / 系列策略`);
  lines.push(`> 已选中: ${selected.length} 个片段`);
  lines.push("");
  lines.push("---");
  lines.push("");

  if (selected.length === 0) {
    lines.push("*尚未生成帖子文案。运行 `yt2x clips generate` 后再查看本报告。*");
    lines.push("");
    return lines.join("\n");
  }

  // 逐帖诊断
  lines.push("## 📝 逐帖诊断");
  lines.push("");

  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]!;
    const text = c.text ?? "";
    lines.push(`### ${c.title}（第 ${i + 1} 篇，共 ${selected.length} 篇）`);
    lines.push("");

    // 首句
    const firstLine = text.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("🧵") && !l.startsWith("🎬") && !l.startsWith("📖") && !l.startsWith("📌") && !l.startsWith("完整") && !l.startsWith("#"));
    if (firstLine) {
      lines.push("**首句：**");
      lines.push(`> ${firstLine.trim()}`);
      lines.push("");

      // 分析首句
      const checks: string[] = [];
      const fl = firstLine.trim();
      if (fl.length < 15) {
        checks.push("⚠️ 首句偏短（<15字），可增加具体场景");
      }
      if (fl.includes("教你") || fl.includes("介绍") || fl.includes("本视频")) {
        checks.push("❌ 首句是摘要腔，应改为画面/场景开场");
      }
      if (/\d/.test(fl)) {
        checks.push("✅ 首句包含数字，有助于抓眼球");
      }
      if (fl.includes("？") || fl.includes("?")) {
        checks.push("✅ 首句用反问/设问，STOP SCROLL 高");
      }
      if (checks.length > 0) {
        lines.push("**首句分析：**");
        for (const chk of checks) lines.push(`- ${chk}`);
        lines.push("");
      }
    }

    // 信息密度
    const numbers = text.match(/\d+\s?[秒倍%$元个行小时天分]|\$\d+|\d+\s?万|\d+\.?\d*[kK]/g);
    if (numbers && numbers.length > 0) {
      lines.push(`**硬信息：** ${[...new Set(numbers)].join(" / ")}`);
      lines.push("");
    } else {
      lines.push("⚠️ 缺少具体数字或硬信息");
      lines.push("");
    }

    // 字数
    const body = text.split("\n").filter(
      (l) => !l.startsWith("---") && !l.startsWith("ref:") && !l.startsWith("clipId:")
        && !l.startsWith("type:") && !l.startsWith("platform:") && !l.startsWith("series:")
        && !l.startsWith("---"),
    ).join("\n");
    const charCount = body.replace(/\s/g, "").length;
    const countOk = charCount >= 150 && charCount <= 300;
    lines.push(`**正文长度：** ${charCount} 字${countOk ? " ✅" : " ⚠️ (目标 150-300)"}`);
    lines.push("");

    // 视频匹配
    lines.push(`**视频：** \`${c.video}\`（${Math.round(c.timecodes.durationSec)}s）`);
    lines.push("");

    // 模板检查
    if (c.nextTeaser) {
      lines.push(`**预告：** ${c.nextTeaser}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // 系列整体评估
  lines.push("## 📊 系列整体评估");
  lines.push("");

  const allFirstLines = selected.map((c) => {
    const t = c.text ?? "";
    return t.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("🧵") && !l.startsWith("🎬") && !l.startsWith("📖") && !l.startsWith("📌") && !l.startsWith("完整") && !l.startsWith("#"))?.trim() ?? "";
  });

  const hasNumbers = selected.filter((c) => /\d/.test(c.text ?? "")).length;
  const avgLen = Math.round(
    selected.reduce((s, c) => s + ((c.charCount ?? 0) || (c.text ?? "").length), 0) / selected.length,
  );

  lines.push(`| 维度 | 评估 |`);
  lines.push(`|------|------|`);
  lines.push(`| 帖子总数 | ${selected.length} 篇 |`);
  lines.push(`| 平均字数 | ${avgLen} 字 ${avgLen >= 150 && avgLen <= 300 ? "✅" : "⚠️"} |`);
  lines.push(`| 含硬信息的帖子 | ${hasNumbers}/${selected.length} ✅ |`);
  lines.push(`| 首句 STYLE | ${allFirstLines.every((l) => !l.includes("教你") && !l.includes("介绍")) ? "场景开场 ✅" : "部分摘要腔 ⚠️"} |`);
  lines.push(`| 系列预告串联 | ${selected.filter((c) => c.nextTeaser).length}/${selected.length} 篇有预告`);

  if (selected.length > 1) {
    const nextRefs = selected.slice(0, -1).filter((c, i) => {
      if (!c.nextTeaser) return false;
      const next = selected[i + 1];
      return next && c.nextTeaser.includes(next.title.slice(0, 4));
    });
    lines.push(`| 预告与下篇内容相关 | ${nextRefs.length}/${selected.length - 1} ${nextRefs.length >= Math.floor((selected.length - 1) / 2) ? "✅" : "⚠️"} |`);
  }
  lines.push("");

  lines.push("### 发布节奏建议");
  lines.push("");
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]!;
    const day = i === 0 ? "Day 1（首发）" : `Day ${i + 1}`;
    const note = i === 0
      ? "最有冲击力的内容，拉新"
      : i === selected.length - 1
        ? "收尾引流，引导看完整文章"
        : "维持热度，保持系列连贯";
    lines.push(`- **${day}**：${c.title} — ${note}`);
  }
  lines.push("");

  // 数据核验
  lines.push("### 📁 文件核验");
  lines.push("");
  for (const c of selected) {
    const postFile = `post-${selected.indexOf(c) + 1}-${c.slug}.md`;
    lines.push(`- ✅ 视频 \`${c.video}\` 就绪`);
    lines.push(`  - 帖子 \`${postFile}\` ${c.text ? "✅ 有内容" : "❌ 无内容"}`);
  }
  lines.push("");

  return lines.join("\n");
};

// ═══════════════════════════════════════════
// 统一写入函数
// ═══════════════════════════════════════════

export type WriteReportsResult = {
  decompositionPath: string;
  reviewPath: string;
};

export const writeReports = async (
  articleDir: string,
  manifest: DeconstructManifest,
  articleTitle?: string,
): Promise<WriteReportsResult> => {
  const clipsDir = path.join(articleDir, "clips");
  const title = articleTitle ?? manifest.source.title;

  const decompositionPath = path.join(clipsDir, "DECOMPOSITION.md");
  await writeFile(decompositionPath, generateDecompositionReport(manifest, title), "utf8");

  const reviewPath = path.join(clipsDir, "PROFESSIONAL-REVIEW.md");
  await writeFile(reviewPath, generateProfessionalReview(manifest, title), "utf8");

  return { decompositionPath, reviewPath };
};
