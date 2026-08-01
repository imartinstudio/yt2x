import { createHash } from "node:crypto";
import type { ProcessRunner } from "../process/index.js";
import {
  auditSubtitleArtifacts,
  isSubtitleAuditReadyForDelivery,
  type SubtitleAuditIssue,
} from "../acquire/audit-subtitles.js";
import { measureBilingualSubtitleLayout } from "../acquire/burn-bilingual-subtitles.js";

/**
 * 配音统一交付的第二道门：字幕布局（字宽/换行/字体回退）与三份 SRT（中/英/双语）的
 * 一致性检查，复用双语字幕交付路径已有的 `auditSubtitleArtifacts`（见
 * `acquire/audit-subtitles.ts`）——不是重新发明一套规则。
 *
 * 与纯字幕路径（`video-subtitles.ts` 的 `runArticleBilingualPipeline`）的用法有一处
 * 不同：那条路径的 `sourceSrt` 是翻译前的英文原始字幕，`coverage-loss` 检查确保 LLM
 * 翻译没有漏词。配音链路没有这样一份独立"翻译前源文本"可比对——`enSrt` 本身就是从
 * ASR 词级时间戳切出的话语单元原文，经显示单元细分后逐条落地，不存在译前/译后两份
 * 文本的区别。这里把 `enSrt` 自身同时当作 `sourceSrt` 传入，让 `source-sha` /
 * `coverage-loss` 两条检查自然通过（比对对象就是它自己），把审计收窄到真正与配音链路
 * 相关的维度：时间戳有效性、双语三份 SRT 的逐条对齐、术语保护（`glossary-violation`，
 * 覆盖 grill/fidelity 这类必须保留英文的派生词）、宽度预算、cps/flash 阅读速度，以及
 * 传入的字体测量结果（hard-layout / unsafe-layout / line-count）。
 */

export type DubBilingualGateInput = {
  bilingualSrt: string;
  zhSrt: string;
  enSrt: string;
  videoWidth: number;
  videoHeight: number;
  runner: ProcessRunner;
  signal?: AbortSignal;
  /**
   * 每个话语单元的实测终点（毫秒，升序），来自 `DubPlacedLine.endMs`。传给
   * `auditSubtitleArtifacts` 让术语保护校验按话语单元分组比对，而不是逐条显示单元
   * 比对——见 `audit-subtitles.ts` 的 `utteranceBoundariesMs` 注释。
   */
  utteranceBoundariesMs?: readonly number[];
};

export type DubBilingualGateResult = {
  readyForBurn: boolean;
  issues: readonly SubtitleAuditIssue[];
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const evaluateDubBilingualGate = async (
  input: DubBilingualGateInput,
): Promise<DubBilingualGateResult> => {
  const measurements = await measureBilingualSubtitleLayout({
    srtContent: input.bilingualSrt,
    videoWidth: input.videoWidth,
    videoHeight: input.videoHeight,
    runner: input.runner,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const report = auditSubtitleArtifacts({
    sourceSrt: input.enSrt,
    enSrt: input.enSrt,
    zhSrt: input.zhSrt,
    bilingualSrt: input.bilingualSrt,
    manifest: { sourceSha256: sha256(input.enSrt) },
    measurements,
    ...(input.utteranceBoundariesMs !== undefined
      ? { utteranceBoundariesMs: input.utteranceBoundariesMs }
      : {}),
  });

  return {
    readyForBurn: isSubtitleAuditReadyForDelivery(report, "burned"),
    issues: report.issues,
  };
};
