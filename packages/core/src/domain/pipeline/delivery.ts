import { z } from "zod";

/** 见 CONTEXT.md「交付物」六档；改表要同步改这里。 */
export const DeliverModeSchema = z.enum([
  "none",
  "zh-srt",
  "zh-burned",
  "bilingual-srt",
  "bilingual-burned",
  "dubbed",
]);
export type DeliverMode = z.infer<typeof DeliverModeSchema>;

/** 见 CONTEXT.md「字幕通道」五条；改表要同步改这里。 */
export const FromModeSchema = z.enum(["youtube", "transcribe", "local", "local-words", "file"]);
export type FromMode = z.infer<typeof FromModeSchema>;

/** `--from` 未显式给出时的解析结果之一：沿用现有 auto 探测（YouTube 优先，找不到退到 transcribe）。 */
export const AUTO_FROM = "auto" as const;
export type FromResolution = FromMode | typeof AUTO_FROM;

export class DeliveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryConflictError";
  }
}

/**
 * `dubbed` 是唯一需要词级时间戳的交付档（CONTEXT.md「字幕通道」），因此是唯一强制通道的档位。
 *
 * `local-words` 反过来也只服务 `dubbed`——非 dubbed 场景选它没有意义，报错而不是静默退化成 `local`。
 * 注：ADR-0006 只给出了 `dubbed+youtube` 一个反例，未明说非 dubbed 场景下选 `local-words` 如何处理。
 * 禁止非 dubbed 模式配合 local-words 是本实现的推断：既然 local-words 只有在配音时才有用，
 * 允许它在非 dubbed 场景下静默退化为 local 只会制造「参数传了但没生效」的混淆。
 * 选择报错延续 ADR-0006 Decision #3「显式矛盾一律报错，绝不静默改写」的精神。
 */
export const assertFromCompatibleWithDeliver = (deliver: DeliverMode, from: FromMode): void => {
  if (deliver === "dubbed" && from !== "local-words") {
    throw new DeliveryConflictError(
      `--deliver dubbed --from ${from} 无法配音：该通道没有词级时间戳。` +
        `改用 --from local-words（先跑 yt2x subtitle transcribe-local）。`,
    );
  }
  if (deliver !== "dubbed" && from === "local-words") {
    throw new DeliveryConflictError(
      `--deliver ${deliver} --from local-words 没有意义：local-words 只服务 --deliver dubbed。` +
        `改用 --from local 读句级本地转录。`,
    );
  }
};

/**
 * 解析本次交付实际要用的字幕来源通道。显式传 --from 时只做矛盾校验；未传时按交付档给出隐含
 * 默认——dubbed 隐含 local-words（配音的唯一前提），其余档位维持现有 auto 探测行为不变。
 */
export const resolveFrom = (
  deliver: DeliverMode,
  explicitFrom: FromMode | undefined,
): FromResolution => {
  if (explicitFrom !== undefined) {
    assertFromCompatibleWithDeliver(deliver, explicitFrom);
    return explicitFrom;
  }
  return deliver === "dubbed" ? "local-words" : AUTO_FROM;
};

export type InternalSubtitleParams = {
  subtitleZh: "off" | "srt" | "burned";
  subtitleBilingual: "off" | "srt" | "burned";
  needsDub: boolean;
};

/**
 * 设计说明：zh-only 烧字与 bilingual 烧字决不能在同一次运行中都触发——这是本仓库早期历史中
 * 真实发生过的 bug（Plan 1 的 CONTEXT.md 引用过）且已修复：`prepareSourceSubtitle`/`runSubtitlePipeline`
 * 中 zh-only 烧字写 `full.zh-burned.mp4`，bilingual 烧字写 `full.bilingual-burned.mp4` 为两个
 * **独立的** 文件，而后运行的那一次会默默覆写 `manifest.burned_video` 字段，孤立前一次的真实
 * 磁盘占用的编码。因此下文所有 bilingual-* 档位均设置 `subtitleZh: "off"`——这**不会**跳过中文字幕
 * 生成（根据 `video-subtitles.ts` 的 `!hasZhSrt` 保护，只要 bilingual 模式不是 off，就会翻译成
 * `full.zh.srt`，与 `subtitleZh` 无关），只是跳过 **zh-only 烧字的副作用**。`dubbed` 档位两者都设
 * `off`，因为配音自有专属的翻译和烧字流程（`executeNativeDub` 从不调用 `runSubtitlePipeline`）——
 * 喂给它 `subtitleZh`/`subtitleBilingual` 值纯属浪费（acquire 会烧字而 dub 要覆写）。
 */
export const internalSubtitleParamsFor = (deliver: DeliverMode): InternalSubtitleParams => {
  switch (deliver) {
    case "none":
      return { subtitleZh: "off", subtitleBilingual: "off", needsDub: false };
    case "zh-srt":
      return { subtitleZh: "srt", subtitleBilingual: "off", needsDub: false };
    case "zh-burned":
      return { subtitleZh: "burned", subtitleBilingual: "off", needsDub: false };
    case "bilingual-srt":
      return { subtitleZh: "off", subtitleBilingual: "srt", needsDub: false };
    case "bilingual-burned":
      return { subtitleZh: "off", subtitleBilingual: "burned", needsDub: false };
    case "dubbed":
      return { subtitleZh: "off", subtitleBilingual: "off", needsDub: true };
  }
};
