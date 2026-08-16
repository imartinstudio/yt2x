import {
  buildDubGlossaryRepairUserPrompt,
  buildDubSpeakableRepairUserPrompt,
  buildDubTranslateExpandPrompt,
  buildDubTranslateGlossaryRepairPrompt,
  buildDubTranslateRepairPrompt,
  buildDubTranslateSpeakablePrompt,
  buildDubTranslateTightenPrompt,
  buildDubTranslateUserPrompt,
  DEFAULT_SPEECH_RATE,
  createTechnicalTermGuard,
  dubTranslateCharBudget,
  findMissingProtectedTerms,
  getDubTranslateSystemPrompt,
  hasHardTechnicalTermViolations,
  isTelegraphicChinese,
  type LlmPort,
  type TechnicalTermGuard,
  type TechnicalTermRestoration,
  type TechnicalTermViolation,
  type SpeechRateModel,
  type Utterance,
} from "@yt2x/core";
import { parseJsonWithRepairs, salvagePartialJsonArray } from "../llm/parse-json.js";
import {
  discoverTechnicalTerms,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";

/**
 * 长度受限翻译：英文话语单元 → 能在其时长内说完的中文。
 *
 * 与 script.ts 的朗读化改写并存，不替换它——切换链路是后续 PR 的事，两条路径共存
 * 期间可以在同一素材上对比译文质量与时长达标率。
 */

const BATCH_SIZE = 20;

/**
 * 收紧回合上限。
 *
 * 一轮不够：模型很少一次就把一条超预算 2-3 倍的行压进预算，而超预算是配音
 * 时长门禁失败的直接来源（超预算行 78% 溢出时间槽，预算内行只有 3%）。
 * 封顶是因为每轮一次 provider 调用，且压缩过度自身也有代价——gate 的
 * info-loss 就是看这个；把「装得下」和「别压过头」这两条都交给有界重试，
 * 而不是无限逼近。
 */
const MAX_TIGHTEN_ROUNDS = 3;

/**
 * 低于该占用比就打回重写（相对于该行自己的时长预算）。
 *
 * 60% 而非门禁的 advisory 阈值（0.7）：这里是翻译阶段主动补救的触发线，门禁是
 * 事后报告的观察线，两者职责不同——补救要在明显浪费预算时就出手，门禁允许更高
 * 的容忍度以避免对"忠实压缩、天然短"的行误报。
 */
const UNDER_BUDGET_RETAIN_THRESHOLD = 0.6;

export type DubTranslatedLine = {
  index: number;
  text: string;
  /** 英文原文，供事后核对信息保留率。 */
  sourceText: string;
  /** 该单元可用时长，供事后核对时长达标率。 */
  availableMs: number;
};

export type TranslateUtterancesInput = {
  llm: LlmPort;
  model: string;
  utterances: readonly Utterance[];
  /** 中文 TTS 时长模型；换音色后应重新校准再传入。 */
  rate?: SpeechRateModel;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onBatchDone?: (done: number, total: number) => void;
};

export type TranslateUtterancesResult = {
  lines: DubTranslatedLine[];
  warnings: string[];
  technicalTermProfileFingerprint: string;
};

type ParsedLine = { index: number; text: string };

/**
 * 一条候选译文经术语守卫处理后的结果。
 *
 * `violations` 非空表示这一版仍然违规：初译/补齐两轮**照样收下**——一行把术语说
 * 成中文，也好过一段静音；后续 tighten / expand / glossary / speakable 几轮则拒绝
 * 用它去覆盖已有译文。谁能接受违规版本由调用点自己决定，这里只如实报告。
 */
type AcceptedDubCandidate = {
  text: string;
  violations: readonly TechnicalTermViolation[];
};

type PreparedDubUtterance = {
  utterance: Utterance;
  preparedUtterance: Utterance;
  guard: TechnicalTermGuard;
  restoration: TechnicalTermRestoration;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const termOccursInSource = (term: string, sourceText: string): boolean => {
  const words = term.trim().split(/\s+/u).filter(Boolean).map(escapeRegExp);
  return words.length > 0
    && new RegExp(`(?<![A-Za-z0-9])${words.join("\\s+")}(?![A-Za-z0-9])`, "iu").test(sourceText);
};

const scopeDubTechnicalTermGuard = (
  guard: TechnicalTermGuard,
  sourceText: string,
): TechnicalTermGuard => createTechnicalTermGuard({
  sourceText,
  // 每句配音都是 1:1 翻译单元：显式声明 unit 作用域，源句里的术语必须落进译文。
  // 不声明就会退化成重写类产物的宽松判定（漏讲术语不算错）。
  sourceUnitId: `dub-utterance:${sourceText}`,
  discoveredTerms: guard.profile.entries
    .filter((entry) => termOccursInSource(entry.sourceText, sourceText))
    .map((entry) => ({
      sourceText: entry.sourceText,
      confidence: "high" as const,
      category: "domain" as const,
    })),
  discovery: guard.profile.discovery,
});

const parseResponse = (content: string): ParsedLine[] => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithRepairs(content);
  } catch {
    parsed = salvagePartialJsonArray(content);
  }
  if (!Array.isArray(parsed)) parsed = salvagePartialJsonArray(content);
  if (!Array.isArray(parsed)) return [];

  const lines: ParsedLine[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.index === "number" && typeof obj.text === "string") {
      const text = obj.text.trim();
      // 空串当成没返回，交给补齐阶段——写进配音稿会变成一段静音
      if (text.length > 0) lines.push({ index: obj.index, text });
    }
  }
  return lines;
};

const translateBatch = async (
  batch: readonly Utterance[],
  input: TranslateUtterancesInput,
  repairMode: boolean,
  promptRule: string,
): Promise<ParsedLine[]> => {
  const rate = input.rate ?? DEFAULT_SPEECH_RATE;
  const systemPrompt = repairMode
    ? buildDubTranslateRepairPrompt(batch.map((u) => u.index), promptRule)
    : getDubTranslateSystemPrompt(promptRule);

  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildDubTranslateUserPrompt(batch, rate) },
    ],
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens ?? 8192,
    jsonMode: true,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const known = new Set(batch.map((u) => u.index));
  // LLM 偶尔自己编 index，编出来的行没有对应原文，留着只会污染补齐判断
  return parseResponse(resp.content.trim()).filter((l) => known.has(l.index));
};

export const translateUtterances = async (
  input: TranslateUtterancesInput,
): Promise<TranslateUtterancesResult> => {
  const warnings: string[] = [];
  const translated = new Map<number, string>();
  const total = input.utterances.length;
  const sourceText = input.utterances.map((utterance) => utterance.text).join("\n");
  const discovery = await discoverTechnicalTerms({
    llm: input.llm,
    model: input.model,
    sourceText,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  warnings.push(...discovery.warnings.map((item) => `technical term discovery: ${item.message}`));
  const technicalTermGuard = createTechnicalTermGuard({
    sourceText,
    discoveredTerms: discovery.accepted,
    discovery: technicalTermDiscoveryAuditFor(discovery),
  });
  const promptRule = technicalTermGuard.prepare([]).promptRule;
  const preparedByUtterance = new Map<number, PreparedDubUtterance>();
  for (const utterance of input.utterances) {
    const guard = scopeDubTechnicalTermGuard(technicalTermGuard, utterance.text);
    const prepared = guard.prepare(utterance.text);
    preparedByUtterance.set(utterance.index, {
      utterance,
      preparedUtterance: { ...utterance, text: prepared.value },
      guard,
      restoration: prepared.restoration,
    });
  }
  /**
   * 每条话语单元各自一次定向修复名额。
   *
   * 曾经是整次调用共用的一个布尔量，含义变成「每部片一次」：第一条违规行用掉名额
   * 之后，后续每条违规行都拿不到修复、直接被判丢弃。真实全片 621 个单元里 69 个
   * （其中 81% 含受保护术语）就是这样静默消失的，最后被门禁的 dropped-utterances
   * 拦停。改成按 index 记账，恢复引入时写明的「每条候选一次有界修复」语义。
   */
  const repairedIndices = new Set<number>();
  const acceptDubCandidate = async (
    utterance: Utterance,
    text: string,
  ): Promise<AcceptedDubCandidate | null> => {
    const prepared = preparedByUtterance.get(utterance.index);
    if (prepared === undefined) return null;
    const finalized = prepared.guard.finalize(text, prepared.restoration);
    if (!hasHardTechnicalTermViolations(finalized.violations)) {
      return { text: finalized.value, violations: [] };
    }
    if (repairedIndices.has(utterance.index)) {
      return { text: finalized.value, violations: finalized.violations };
    }
    repairedIndices.add(utterance.index);
    const repaired = await repairTechnicalTermViolations({
      llm: input.llm,
      model: input.model,
      guard: prepared.guard,
      currentValue: finalized.value,
      restoration: prepared.restoration,
      violations: finalized.violations,
      parseResponse: (content) => {
        const parsedLines = parseResponse(content.trim());
        return parsedLines.find((line) => line.index === utterance.index)?.text ?? content.trim();
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // 修复没成功就留着原译文，不拿一个同样违规的版本盖掉另一个——与本文件
    // glossary / speakable 两轮补救的处置一致。
    return hasHardTechnicalTermViolations(repaired.violations)
      ? { text: finalized.value, violations: finalized.violations }
      : { text: repaired.value, violations: [] };
  };

  if (total === 0) {
    return {
      lines: [],
      warnings,
      technicalTermProfileFingerprint: technicalTermGuard.profile.profileFingerprint,
    };
  }

  // 收下但仍带术语违规的行；末尾如实报出来，让门禁/人工知道该复核哪几条。
  const unresolvedViolations = new Set<number>();
  const acceptIntoScript = async (utterance: Utterance, text: string): Promise<void> => {
    const accepted = await acceptDubCandidate(utterance, text);
    if (accepted === null) return;
    translated.set(utterance.index, accepted.text);
    if (accepted.violations.length > 0) unresolvedViolations.add(utterance.index);
    else unresolvedViolations.delete(utterance.index);
  };

  let done = 0;
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = input.utterances.slice(i, i + BATCH_SIZE);
    try {
      for (const line of await translateBatch(
        batch.map((utterance) => preparedByUtterance.get(utterance.index)!.preparedUtterance),
        input,
        false,
        promptRule,
      )) {
        const utterance = input.utterances.find((candidate) => candidate.index === line.index);
        if (utterance !== undefined) await acceptIntoScript(utterance, line.text);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(
        `translate batch ${batch[0]!.index}-${batch[batch.length - 1]!.index} failed: ${message}`,
      );
    }
    done += batch.length;
    input.onBatchDone?.(done, total);
  }

  // 补齐：把所有缺行凑成一批，用写死 index 的 repair prompt 再要一次
  const missing = input.utterances.filter((u) => !translated.has(u.index));
  if (missing.length > 0) {
    try {
      const before = translated.size;
      for (const line of await translateBatch(
        missing.map((utterance) => preparedByUtterance.get(utterance.index)!.preparedUtterance),
        input,
        true,
        promptRule,
      )) {
        const utterance = input.utterances.find((candidate) => candidate.index === line.index);
        if (utterance !== undefined) await acceptIntoScript(utterance, line.text);
      }
      warnings.push(`repaired ${translated.size - before}/${missing.length} missing lines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`repair pass failed: ${message}`);
    }
  }

  // 仍然缺的行如实报出来，不编造译文——一段静音比一句假话好排查
  const stillMissing = input.utterances.filter((u) => !translated.has(u.index));
  if (stillMissing.length > 0) {
    warnings.push(`no translation for index ${stillMissing.map((u) => u.index).join(", ")}`);
  }

  // 收紧：超预算的行拿英文原文重译一版，而不是把已有译文砍短。
  //
  // 循环，不是一轮。以前只跑一次、且「只要更短就收下」——一条超预算 3.7 倍的行
  // 返回 3.0 倍也算收紧成功。真实全片的结果是 `tightened 52/75`，收工时仍有
  // 49/81 行超预算，而超预算正是门禁爆掉的原因：那 49 行里 38 行合成时长超出
  // 时间槽，而预算内的 32 行只有 1 行超。两者相关系数 0.880。
  const rate = input.rate ?? DEFAULT_SPEECH_RATE;
  const budgetOf = (u: Utterance): number => dubTranslateCharBudget(u.endMs - u.startMs, rate);
  const stillOverBudget = (): Utterance[] => input.utterances.filter((u) => {
    const text = translated.get(u.index);
    return text !== undefined && text.length > budgetOf(u);
  });

  for (let attempt = 0; attempt < MAX_TIGHTEN_ROUNDS; attempt += 1) {
    const overBudget = stillOverBudget();
    if (overBudget.length === 0) break;
    try {
      const resp = await input.llm.chat({
        model: input.model,
        messages: [
          {
            role: "system",
            content: buildDubTranslateTightenPrompt(
              overBudget.map((u) => ({
                index: u.index,
                actualChars: translated.get(u.index)!.length,
                maxChars: budgetOf(u),
              })),
              promptRule,
            ),
          },
          {
            role: "user",
            content: buildDubTranslateUserPrompt(
              overBudget.map((utterance) => preparedByUtterance.get(utterance.index)!.preparedUtterance),
              rate,
            ),
          },
        ],
        temperature: input.temperature ?? 0.3,
        maxTokens: input.maxTokens ?? 8192,
        jsonMode: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const known = new Set(overBudget.map((u) => u.index));
      let tightened = 0;
      for (const line of parseResponse(resp.content.trim())) {
        if (!known.has(line.index)) continue;
        const utterance = input.utterances.find((candidate) => candidate.index === line.index);
        if (utterance === undefined) continue;
        const accepted = await acceptDubCandidate(utterance, line.text);
        if (accepted === null || accepted.violations.length > 0) continue;
        // 只在真的更短时替换：重译偶尔会更长，那一版没有价值
        if (accepted.text.length < translated.get(line.index)!.length) {
          translated.set(line.index, accepted.text);
          unresolvedViolations.delete(line.index);
          tightened += 1;
        }
      }
      warnings.push(
        `tighten round ${attempt + 1}: tightened ${tightened}/${overBudget.length} over-budget lines`,
      );
      // 一轮下来一条都没变短就不必再要一次：模型已经交不出更短的版本，
      // 继续只会重复花钱。
      if (tightened === 0) break;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`tighten pass failed: ${message}`);
      break;
    }
  }

  const unfitted = stillOverBudget();
  if (unfitted.length > 0) {
    warnings.push(
      `${unfitted.length} line(s) still over their character budget after `
      + `${MAX_TIGHTEN_ROUNDS} tighten round(s): index ${unfitted.map((u) => u.index).join(", ")}`,
    );
  }

  // 反向：远低于预算的行拿英文原文重译一版，把省下的空间用来把内容说完整。
  // 预算本身就短于固定开销的行（budgetOf 被钳到 1）没有真正的时长可填，
  // 交给后续静音/协商吸收，重译解决不了。
  const underBudget = input.utterances.filter((u) => {
    const text = translated.get(u.index);
    if (text === undefined) return false;
    const availableMs = u.endMs - u.startMs;
    if (availableMs <= rate.fixedOverheadMs) return false;
    return text.length / budgetOf(u) < UNDER_BUDGET_RETAIN_THRESHOLD;
  });

  if (underBudget.length > 0) {
    try {
      const resp = await input.llm.chat({
        model: input.model,
        messages: [
          {
            role: "system",
            content: buildDubTranslateExpandPrompt(
              underBudget.map((u) => ({
                index: u.index,
                actualChars: translated.get(u.index)!.length,
                maxChars: budgetOf(u),
              })),
              promptRule,
            ),
          },
          {
            role: "user",
            content: buildDubTranslateUserPrompt(
              underBudget.map((utterance) => preparedByUtterance.get(utterance.index)!.preparedUtterance),
              rate,
            ),
          },
        ],
        temperature: input.temperature ?? 0.3,
        maxTokens: input.maxTokens ?? 8192,
        jsonMode: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const known = new Set(underBudget.map((u) => u.index));
      let expanded = 0;
      for (const line of parseResponse(resp.content.trim())) {
        if (!known.has(line.index)) continue;
        const utterance = input.utterances.find((candidate) => candidate.index === line.index);
        if (utterance === undefined) continue;
        const accepted = await acceptDubCandidate(utterance, line.text);
        if (accepted === null || accepted.violations.length > 0) continue;
        // 只在真的更长时替换：重译偶尔仍给出同样短的版本，那一版没有价值
        if (accepted.text.length > translated.get(line.index)!.length) {
          translated.set(line.index, accepted.text);
          unresolvedViolations.delete(line.index);
          expanded += 1;
        }
      }
      warnings.push(`expanded ${expanded}/${underBudget.length} under-budget lines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`expand pass failed: ${message}`);
    }
  }

  // 术语补漏：扫一遍已有译文，找出源文本里出现却没有原样进入译文的保护术语
  // （rule 9），拿具体缺了什么词定向重译。这是门禁 glossary-violation 检查会拦的
  // 同一个缺陷类别——放在翻译阶段修，不必等真的跑到门禁才发现要重跑全片。
  const glossaryMissing = input.utterances
    .map((u) => {
      const text = translated.get(u.index);
      if (text === undefined) return undefined;
      const missingTerms = findMissingProtectedTerms(u.text, text);
      return missingTerms.length > 0 ? { utterance: u, missingTerms } : undefined;
    })
    .filter((entry): entry is { utterance: Utterance; missingTerms: string[] } => entry !== undefined);

  if (glossaryMissing.length > 0) {
    try {
      const resp = await input.llm.chat({
        model: input.model,
        messages: [
          {
            role: "system",
            content: buildDubTranslateGlossaryRepairPrompt(
              glossaryMissing.map((m) => ({ index: m.utterance.index, terms: m.missingTerms })),
              promptRule,
            ),
          },
          {
            role: "user",
            // 喂当前译文而非英文原文——补漏是编辑任务，重译只会让模型把刚做错的
            // 取舍再做一遍（见 buildDubTranslateGlossaryRepairPrompt 的注释）。
            content: buildDubGlossaryRepairUserPrompt(
              glossaryMissing.map((m) => ({
                index: m.utterance.index,
                text: translated.get(m.utterance.index) ?? "",
                maxChars: dubTranslateCharBudget(m.utterance.endMs - m.utterance.startMs, rate),
              })),
            ),
          },
        ],
        // 定向补漏，不需要创造性；低温更容易老实照抄指定术语。
        temperature: 0.1,
        maxTokens: input.maxTokens ?? 8192,
        jsonMode: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const byIndex = new Map(glossaryMissing.map((m) => [m.utterance.index, m]));
      let repaired = 0;
      for (const line of parseResponse(resp.content.trim())) {
        const entry = byIndex.get(line.index);
        if (entry === undefined) continue;
        const accepted = await acceptDubCandidate(entry.utterance, line.text);
        if (accepted === null || accepted.violations.length > 0) continue;
        // 只在新译文真的把缺失术语补回来时才替换，否则保留原译文——不用一个
        // "同样丢词"的版本去覆盖一个已知丢词的版本，门禁该拦的还是拦得住。
        if (findMissingProtectedTerms(entry.utterance.text, accepted.text).length === 0) {
          translated.set(line.index, accepted.text);
          unresolvedViolations.delete(line.index);
          repaired += 1;
        }
      }
      warnings.push(`glossary-repaired ${repaired}/${glossaryMissing.length} lines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`glossary repair pass failed: ${message}`);
    }
  }

  // 电报体补救：预算话术会把模型带进"压缩语域"——最省字的写法就是切换到文言。
  // 真实全片 121 句里 36 句零标点（「故我做此视频助你精通这些技能」这种），念出来
  // 听不懂，而且大多**还没用满预算**，说明不是字数逼的。放在最后一道：前面的
  // tighten/expand 都可能把一行重新压成电报体，这里兜底。
  const telegraphic = input.utterances
    .map((u) => {
      const text = translated.get(u.index);
      return text !== undefined && isTelegraphicChinese(text) ? { utterance: u, text } : undefined;
    })
    .filter((e): e is { utterance: Utterance; text: string } => e !== undefined);

  if (telegraphic.length > 0) {
    try {
      const resp = await input.llm.chat({
        model: input.model,
        messages: [
          {
            role: "system",
            content: buildDubTranslateSpeakablePrompt(
              telegraphic.map((t) => ({ index: t.utterance.index })),
              promptRule,
            ),
          },
          {
            role: "user",
            content: buildDubSpeakableRepairUserPrompt(
              telegraphic.map((t) => ({
                index: t.utterance.index,
                en: t.utterance.text,
                zh: t.text,
                maxChars: dubTranslateCharBudget(
                  t.utterance.endMs - t.utterance.startMs,
                  rate,
                ),
              })),
            ),
          },
        ],
        temperature: 0.2,
        maxTokens: input.maxTokens ?? 8192,
        jsonMode: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const telegraphicByIndex = new Map(
        telegraphic.map(({ utterance }) => [utterance.index, utterance] as const),
      );
      let speakable = 0;
      for (const line of parseResponse(resp.content.trim())) {
        // 只在改写确实不再是电报体时才替换——否则留着原译文，别拿一个同样难读的
        // 版本盖掉一个已知难读的版本；同时再次校验保护术语，避免口语化改写把英文
        // 专名掏掉。
        const utterance = telegraphicByIndex.get(line.index);
        const accepted = utterance === undefined ? null : await acceptDubCandidate(utterance, line.text);
        if (
          utterance !== undefined &&
          accepted !== null &&
          accepted.violations.length === 0 &&
          !isTelegraphicChinese(accepted.text) &&
          findMissingProtectedTerms(utterance.text, accepted.text).length === 0
        ) {
          translated.set(line.index, accepted.text);
          unresolvedViolations.delete(line.index);
          speakable += 1;
        }
      }
      warnings.push(`speakable-repaired ${speakable}/${telegraphic.length} lines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`speakable repair pass failed: ${message}`);
    }
  }

  // 收下了但术语仍不达标的行：内容在、发音可能把专名念成中文。如实报出来，别让
  // 它混在「一切正常」里——门禁的 glossary 检查在配音链路是 advisory（见
  // bilingual-gate.ts），这条 warning 是它在翻译阶段的对应物。
  const unresolved = [...unresolvedViolations].sort((a, b) => a - b);
  if (unresolved.length > 0) {
    warnings.push(
      `kept ${unresolved.length}/${total} lines with unresolved technical-term violations: index ${unresolved.join(", ")}`,
    );
  }

  const lines: DubTranslatedLine[] = input.utterances
    .filter((u) => translated.has(u.index))
    .map((u) => ({
      index: u.index,
      text: translated.get(u.index)!,
      sourceText: u.text,
      availableMs: u.endMs - u.startMs,
    }));

  return {
    lines,
    warnings,
    technicalTermProfileFingerprint: technicalTermGuard.profile.profileFingerprint,
  };
};
