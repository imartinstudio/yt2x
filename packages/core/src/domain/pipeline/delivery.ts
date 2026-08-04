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
 * `dubbed` 是唯一需要词级时间戳的交付档（CONTEXT.md「字幕通道」），因此是唯一强制通道的档位；
 * `local-words` 反过来也只服务 `dubbed`——非 dubbed 场景选它没有意义，报错而不是静默退化成
 * `local`（ADR-0006 Decision #3：显式矛盾一律报错，绝不静默改写）。
 */
export const assertFromCompatibleWithDeliver = (deliver: DeliverMode, from: FromMode): void => {
  if (deliver === "dubbed" && from !== "local-words") {
    throw new DeliveryConflictError(
      `--deliver dubbed --from ${from} 无法配音：该通道没有词级时间戳。` +
        `改用 --from local-words（先跑 yt2x subtitle-tools transcribe-local）。`,
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
