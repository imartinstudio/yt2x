export type TechnicalTermPolicy = "preserve" | "fixed-zh" | "contextual-preserve";
export type TechnicalTermArtifact = "content" | "visual-prompt";

export type TechnicalTermCategory =
  | "ai"
  | "ai-coding"
  | "ai-agent"
  | "product"
  | "person"
  | "domain";

export type TechnicalTermEntry = {
  canonical: string;
  aliases: readonly string[];
  categories: readonly TechnicalTermCategory[];
  policy: TechnicalTermPolicy;
  preferredZh?: string;
  forbiddenZh?: readonly string[];
};

export type DiscoveredTechnicalTerm = {
  sourceText: string;
  confidence: "high" | "medium" | "low";
  category: TechnicalTermCategory;
};

export type TechnicalTermViolationCode =
  | "missing-canonical-term"
  | "forbidden-translation"
  | "unrestored-placeholder"
  | "invented-canonical-term"
  | "conflicting-term-policy";

export type TechnicalTermViolation = {
  code: TechnicalTermViolationCode;
  canonical?: string;
  message: string;
};

export type ResolvedTechnicalTerm = {
  canonical: string;
  sourceText: string;
  policy: TechnicalTermPolicy;
  preferredZh?: string;
  forbiddenZh: readonly string[];
};

export type TechnicalTermOccurrence = {
  canonical: string;
  sourceText: string;
  start: number;
  end: number;
  source: "sourceText" | "sourceTitle";
};

export type TechnicalTermProfile = {
  sourceFingerprint: string;
  entries: readonly ResolvedTechnicalTerm[];
  occurrences: readonly TechnicalTermOccurrence[];
  profileFingerprint: string;
};

export type TechnicalTermRestoration = {
  placeholders: readonly { token: string; canonical: string }[];
};

export type PreparedTechnicalTermValue<T> = {
  value: T;
  promptRule: string;
  restoration: TechnicalTermRestoration;
  profileFingerprint: string;
};

export type FinalizedTechnicalTermValue<T> = {
  value: T;
  violations: readonly TechnicalTermViolation[];
};

export type TechnicalTermGuard = {
  readonly profile: TechnicalTermProfile;
  prepare<T>(value: T): PreparedTechnicalTermValue<T>;
  finalize<T>(value: T, restoration: TechnicalTermRestoration): FinalizedTechnicalTermValue<T>;
  validate<T>(value: T): readonly TechnicalTermViolation[];
};

export type TechnicalTermCatalog = {
  entries: readonly TechnicalTermEntry[];
  fingerprint: string;
};

type TermMatch = {
  entry: TechnicalTermEntry;
  sourceText: string;
  start: number;
  end: number;
  source: "sourceText" | "sourceTitle";
};

const NON_GRAPH_IMAGE_TERM_RE =
  /(?:截图|截屏|缩略图|图片|图像|图表|图标|图形|图案|图层|图纸|图书|图解|图示|示意图|流程图|封面图|配图|插图|地图|草图|图文)/gu;
const PRIVATE_PLACEHOLDER_RE = /\uE000YT2X_TERM_[^\uE001]+\uE001/u;
const FIELD_BOUNDARY = "\uE002YT2X_FIELD_BOUNDARY\uE003";
const HAN_CHAR_RE = /\p{Script=Han}/u;

const freezeEntry = (entry: TechnicalTermEntry): TechnicalTermEntry => Object.freeze({
  canonical: entry.canonical,
  aliases: Object.freeze([...new Set(entry.aliases.map((alias) => alias.trim()).filter(Boolean))]),
  categories: Object.freeze([...new Set(entry.categories)]),
  policy: entry.policy,
  ...(entry.preferredZh === undefined ? {} : { preferredZh: entry.preferredZh }),
  ...(entry.forbiddenZh === undefined
    ? {}
    : { forbiddenZh: Object.freeze([...new Set(entry.forbiddenZh.filter(Boolean))]) }),
});

const normalizedKey = (value: string): string => value.trim().toLocaleLowerCase("en");

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const fingerprint = (value: unknown): string => {
  let hash = 2166136261;
  for (const character of stableSerialize(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const catalogFingerprintValue = (entries: readonly TechnicalTermEntry[]) =>
  entries
    .map((entry) => ({
      canonical: entry.canonical,
      aliases: [...entry.aliases].sort((a, b) => normalizedKey(a).localeCompare(normalizedKey(b))),
      categories: [...entry.categories].sort(),
      policy: entry.policy,
      preferredZh: entry.preferredZh,
      forbiddenZh: [...(entry.forbiddenZh ?? [])].sort(),
    }))
    .sort((a, b) => normalizedKey(a.canonical).localeCompare(normalizedKey(b.canonical)));

export const defineTechnicalTermCatalog = (
  rawEntries: readonly TechnicalTermEntry[],
): TechnicalTermCatalog => {
  const seen = new Map<string, string>();
  const entries = rawEntries.map((entry) => {
    if (entry.canonical.trim() === "") throw new Error("canonical term must not be empty");
    if (entry.categories.length === 0) throw new Error(`term ${entry.canonical} needs a category`);
    if (entry.policy === "fixed-zh" && !entry.preferredZh?.trim()) {
      throw new Error(`fixed-zh term ${entry.canonical} requires preferredZh`);
    }
    const frozen = freezeEntry(entry);
    if (seen.has(normalizedKey(frozen.canonical))) {
      throw new Error(`duplicate canonical: ${frozen.canonical}`);
    }
    for (const candidate of [frozen.canonical, ...frozen.aliases]) {
      const key = normalizedKey(candidate);
      const previous = seen.get(key);
      if (previous !== undefined && previous !== frozen.canonical) {
        throw new Error(`alias conflict: ${candidate} belongs to ${previous} and ${frozen.canonical}`);
      }
      seen.set(key, frozen.canonical);
    }
    return frozen;
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    fingerprint: fingerprint(catalogFingerprintValue(entries)),
  });
};

const entry = (
  canonical: string,
  categories: readonly TechnicalTermCategory[],
  policy: TechnicalTermPolicy = "preserve",
  options: Partial<Pick<TechnicalTermEntry, "aliases" | "preferredZh" | "forbiddenZh">> = {},
): TechnicalTermEntry => {
  const { aliases = [], ...rest } = options;
  return { canonical, categories, policy, aliases, ...rest };
};

const INITIAL_CATALOG: readonly TechnicalTermEntry[] = [
  entry("Artificial Intelligence", ["ai"], "preserve", { aliases: ["artificial intelligence"] }),
  entry("Large Language Model", ["ai"], "preserve", { aliases: ["large language model"] }),
  entry("Foundation Model", ["ai"], "preserve", { aliases: ["foundation model"] }),
  entry("Embedding", ["ai"], "preserve", { aliases: ["embedding"] }),
  entry("Vector Database", ["ai"], "preserve", { aliases: ["vector database"] }),
  entry("Retrieval-Augmented Generation", ["ai"], "preserve", {
    aliases: ["retrieval-augmented generation"],
    forbiddenZh: ["检索增强生成"],
  }),
  entry("RAG", ["ai"], "preserve", { aliases: ["rag"] }),
  entry("AI Coding", ["ai-coding"], "preserve", { aliases: ["ai coding"] }),
  entry("Coding Agent", ["ai-coding"], "preserve", { aliases: ["coding agent"] }),
  entry("Code Generation", ["ai-coding"], "preserve", { aliases: ["code generation"] }),
  entry("Prompt Engineering", ["ai-coding"], "preserve", {
    aliases: ["prompt engineering"],
    forbiddenZh: ["提示工程"],
  }),
  entry("Context Engineering", ["ai-coding"], "preserve", {
    aliases: ["context engineering"],
    forbiddenZh: ["上下文工程"],
  }),
  entry("Model Context Protocol", ["ai-coding"], "preserve", {
    aliases: ["model context protocol"],
  }),
  entry("MCP", ["ai-coding"], "preserve", { aliases: ["mcp"] }),
  entry("Structured Output", ["ai-coding"], "preserve", { aliases: ["structured output"] }),
  entry("AI Agent", ["ai-agent"], "preserve", { aliases: ["ai agent"] }),
  entry("Agentic Workflow", ["ai-agent"], "preserve", { aliases: ["agentic workflow"] }),
  entry("Tool Calling", ["ai-agent"], "preserve", { aliases: ["tool calling"] }),
  entry("Function Calling", ["ai-agent"], "preserve", { aliases: ["function calling"] }),
  entry("Graph Engineering", ["ai-agent"], "preserve", {
    aliases: ["graph engineering"],
    forbiddenZh: ["图工程"],
  }),
  entry("Knowledge Graph", ["ai-agent"], "preserve", {
    aliases: ["knowledge graph"],
    forbiddenZh: ["知识图谱"],
  }),
  entry("Agent Graph", ["ai-agent"], "preserve", {
    aliases: ["agent graph"],
    forbiddenZh: ["代理图谱"],
  }),
  entry("Graph", ["ai-agent"], "contextual-preserve", {
    aliases: ["graph"],
    forbiddenZh: ["图"],
  }),
  entry("Grill Me", ["product"], "preserve", { aliases: ["grill me"] }),
  entry("Grill with Docs", ["product"], "preserve", { aliases: ["grill with docs"] }),
  entry("2PRD", ["product"], "preserve", { aliases: ["2prd"] }),
  entry("Codex", ["product"], "preserve", { aliases: ["codex"] }),
  entry("Claude", ["product"], "preserve", { aliases: ["claude"] }),
  entry("ChatGPT", ["product"], "preserve", { aliases: ["chatgpt"] }),
  entry("GPT", ["product"], "preserve", { aliases: ["gpt"] }),
  entry("OpenAI", ["product"], "preserve", { aliases: ["openai"] }),
  entry("Gemini", ["product"], "preserve", { aliases: ["gemini"] }),
  entry("DeepSeek", ["product"], "preserve", { aliases: ["deepseek"] }),
  entry("Cursor", ["product"], "preserve", { aliases: ["cursor"] }),
  entry("GitHub Copilot", ["product"], "preserve", { aliases: ["github copilot"] }),
  entry("Plan Mode", ["product"], "preserve", { aliases: ["plan mode"] }),
  entry("Agents", ["product"], "preserve", { aliases: ["agents"] }),
  entry("PRD", ["product"], "preserve", { aliases: ["prd"] }),
  entry("Air Coding Cohort", ["product"], "preserve", { aliases: ["air coding cohort"] }),
  entry("Shape Up", ["product"], "preserve", { aliases: ["shape up"] }),
  entry("YouTube", ["product"], "preserve", { aliases: ["youtube"] }),
  entry("Discord", ["product"], "preserve", { aliases: ["discord"] }),
  entry("Matt Pocock", ["person"], "preserve", { aliases: ["matt pocock"] }),
  entry("Ryan Singer", ["person"], "preserve", { aliases: ["ryan singer"] }),
  entry("Gary Tan", ["person"], "preserve", { aliases: ["gary tan"] }),
  entry("G Stack", ["person"], "preserve", { aliases: ["g stack"] }),
  entry("grilling session", ["domain"], "fixed-zh", { preferredZh: "追问环节" }),
  entry("grilling sessions", ["domain"], "fixed-zh", { preferredZh: "追问环节" }),
  entry("high fidelity", ["domain"], "fixed-zh", { preferredZh: "高保真" }),
  entry("low fidelity", ["domain"], "fixed-zh", { preferredZh: "低保真" }),
  entry("grillable", ["domain"], "fixed-zh", { preferredZh: "可追问" }),
  entry("ungrillable", ["domain"], "fixed-zh", { preferredZh: "不可追问" }),
  entry("grilling", ["domain"], "fixed-zh", { preferredZh: "追问" }),
  entry("fidelity", ["domain"], "fixed-zh", { preferredZh: "保真度" }),
  entry("grill", ["domain"], "fixed-zh", { preferredZh: "追问" }),
];

const catalog = defineTechnicalTermCatalog(INITIAL_CATALOG);
export const TECHNICAL_TERM_CATALOG = catalog.entries;
export const TECHNICAL_TERM_CATALOG_FINGERPRINT = catalog.fingerprint;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const termPattern = (terms: readonly string[], flags: string): RegExp => {
  const alternatives = [...new Set(terms)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?<![A-Za-z0-9])(${alternatives})(?![A-Za-z0-9])`, flags);
};

const findActualSourceText = (text: string, candidate: string): string | undefined => {
  const parts = candidate.trim().split(/\s+/u).filter(Boolean).map(escapeRegExp);
  if (parts.length === 0) return undefined;
  const match = text.match(new RegExp(
    `(?<![A-Za-z0-9])(${parts.join("\\s+")})(?![A-Za-z0-9])`,
    "iu",
  ));
  return match?.[1];
};

const matchesForEntry = (
  text: string,
  entryToMatch: TechnicalTermEntry,
  source: "sourceText" | "sourceTitle",
): TermMatch[] => {
  const terms = [entryToMatch.canonical, ...entryToMatch.aliases];
  if (terms.length === 0) return [];
  const matches: TermMatch[] = [];
  for (const match of text.matchAll(termPattern(terms, "giu"))) {
    matches.push({
      entry: entryToMatch,
      sourceText: match[1] ?? match[0],
      start: match.index,
      end: match.index + match[0].length,
      source,
    });
  }
  return matches;
};

const overlaps = (a: TermMatch, b: TermMatch): boolean => a.start < b.end && b.start < a.end;

const findProfileMatches = (
  sourceText: string,
  sourceTitle: string,
  discoveredTerms: readonly DiscoveredTechnicalTerm[],
): TermMatch[] => {
  const discoveredEntries = discoveredTerms
    .filter((candidate) => candidate.confidence === "high")
    .filter((candidate, index, all) =>
      all.findIndex((other) => normalizedKey(other.sourceText) === normalizedKey(candidate.sourceText)) === index,
    )
    .filter((candidate) => candidate.sourceText.trim() !== "")
    .map((candidate) => {
      const actualSourceText = findActualSourceText(sourceText, candidate.sourceText)
        ?? findActualSourceText(sourceTitle, candidate.sourceText);
      return actualSourceText === undefined
        ? undefined
        : entry(actualSourceText, [candidate.category], "preserve");
    })
    .filter((candidate): candidate is TechnicalTermEntry => candidate !== undefined);
  const allEntries = [...TECHNICAL_TERM_CATALOG, ...discoveredEntries];
  const selectLongestMatches = (matches: TermMatch[]): TermMatch[] => [...matches]
    .sort((a, b) => b.sourceText.length - a.sourceText.length || a.start - b.start)
    .filter((match, index, all) => all.slice(0, index).every((selected) => !overlaps(match, selected)));
  const sourceMatches = selectLongestMatches(
    allEntries.flatMap((candidate) => matchesForEntry(sourceText, candidate, "sourceText")),
  );
  const titleMatches = selectLongestMatches(
    allEntries.flatMap((candidate) => matchesForEntry(sourceTitle, candidate, "sourceTitle")),
  );
  return [...sourceMatches, ...titleMatches];
};

const resolvedFromMatches = (matches: readonly TermMatch[]): TechnicalTermProfile => {
  const byCanonical = new Map<string, ResolvedTechnicalTerm>();
  for (const match of matches) {
    if (byCanonical.has(match.entry.canonical)) continue;
    byCanonical.set(match.entry.canonical, Object.freeze({
      canonical: match.entry.canonical,
      sourceText: match.sourceText,
      policy: match.entry.policy,
      ...(match.entry.preferredZh === undefined ? {} : { preferredZh: match.entry.preferredZh }),
      forbiddenZh: Object.freeze([...(match.entry.forbiddenZh ?? [])]),
    }));
  }
  const entries = Object.freeze([...byCanonical.values()]);
  const occurrences = Object.freeze(matches.map((match) => Object.freeze({
    canonical: match.entry.canonical,
    sourceText: match.sourceText,
    start: match.start,
    end: match.end,
    source: match.source,
  })));
  return { sourceFingerprint: "", entries, occurrences, profileFingerprint: "" };
};

const replaceInValue = <T>(value: T, replace: (text: string) => string): T => {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return replace(current);
    if (Array.isArray(current)) return current.map(visit);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, visit(child)]));
    }
    return current;
  };
  return visit(value) as T;
};

const replaceGraphWords = (
  value: string,
  replacement: (text: string) => string,
): string => {
  const placeholders = new Map<string, string>();
  const protectedImages = value.replace(NON_GRAPH_IMAGE_TERM_RE, (match) => {
    const token = `\uE000YT2X_IMAGE_${placeholders.size}\uE001`;
    placeholders.set(token, match);
    return token;
  });
  let output = protectedImages.replace(/图/gu, (match: string, offset: number, fullText: string) => {
    const replaced = replacement(match);
    if (replaced === match) return match;
    const previous = fullText[offset - 1] ?? "";
    const next = fullText[offset + match.length] ?? "";
    return `${HAN_CHAR_RE.test(previous) ? " " : ""}${replaced}${HAN_CHAR_RE.test(next) ? " " : ""}`;
  });
  for (const [token, original] of placeholders) output = output.replaceAll(token, original);
  return output;
};

const dedupeViolations = (violations: readonly TechnicalTermViolation[]): TechnicalTermViolation[] => {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.code}\u0000${violation.canonical ?? ""}\u0000${violation.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const createProfile = (
  sourceText: string,
  sourceTitle: string,
  discoveredTerms: readonly DiscoveredTechnicalTerm[],
  artifact: TechnicalTermArtifact,
): TechnicalTermProfile => {
  const matches = findProfileMatches(sourceText, sourceTitle, discoveredTerms);
  const base = resolvedFromMatches(matches);
  const contextualMatches = TECHNICAL_TERM_CATALOG
    .filter((entry) => entry.policy === "contextual-preserve")
    .flatMap((entry) => [
      ...matchesForEntry(sourceText, entry, "sourceText"),
      ...matchesForEntry(sourceTitle, entry, "sourceTitle"),
    ])
    // A contextual term such as Graph may be a substring of a longer,
    // source-active term such as Graph Engineering. Keep it active only when
    // the source profile selected that exact occurrence; otherwise recovery of
    // a natural Chinese "图" in an unrelated output cue becomes global.
    .filter((match) => base.occurrences.some((occurrence) =>
      occurrence.canonical === match.entry.canonical
      && occurrence.start === match.start
      && occurrence.end === match.end
      && occurrence.source === match.source,
    ));
  const contextual = resolvedFromMatches(contextualMatches);
  const mergedEntries = Object.freeze([
    ...base.entries,
    ...contextual.entries.filter((term) => !base.entries.some((existing) => existing.canonical === term.canonical)),
  ]);
  const sourceFingerprint = fingerprint({ sourceText, sourceTitle });
  return Object.freeze({
    sourceFingerprint,
    entries: mergedEntries,
    occurrences: base.occurrences,
    profileFingerprint: fingerprint({
      sourceFingerprint,
      entries: mergedEntries,
      occurrences: base.occurrences,
      catalogFingerprint: TECHNICAL_TERM_CATALOG_FINGERPRINT,
      artifact,
    }),
  });
};

export type CreateTechnicalTermGuardArgs = {
  sourceText: string;
  sourceTitle?: string;
  discoveredTerms?: readonly DiscoveredTechnicalTerm[];
  artifact?: TechnicalTermArtifact;
};

export const createTechnicalTermGuard = ({
  sourceText,
  sourceTitle = "",
  discoveredTerms = [],
  artifact = "content",
}: CreateTechnicalTermGuardArgs): TechnicalTermGuard => {
  const profile = createProfile(sourceText, sourceTitle, discoveredTerms, artifact);
  const preservedEntries = profile.entries.filter(
    (term) => term.policy === "preserve" || term.policy === "contextual-preserve",
  );
  const preservedPatterns = preservedEntries.flatMap((term) => [term.canonical, term.sourceText]);

  const promptRule = [
    "专业术语规则：只保护源材料中实际出现的术语，不要凭空加入目录中的其他词。",
    "preserve/contextual-preserve 术语必须保留 canonical 原文；fixed-zh 术语必须使用指定中文译法。",
    preservedEntries.length === 0
      ? "本次源材料没有命中需要保护的术语。"
      : `本次源材料激活术语：${preservedEntries.map((term) => term.canonical).join("、")}`,
    ...profile.entries
      .filter((term) => term.policy === "fixed-zh")
      .map((term) => `${term.canonical} → ${term.preferredZh}`),
    ...(artifact === "visual-prompt"
      ? ["视觉提示可以使用 graph、diagram、image 等自然英文视觉描述；只有源材料实际激活的技术术语需要保留。"]
      : []),
  ].join("\n");

  const restorePlaceholders = (value: string, restoration: TechnicalTermRestoration): string => {
    let output = value;
    for (const { token, canonical } of restoration.placeholders) output = output.replaceAll(token, canonical);
    return output;
  };

  const applySourceScopedRecovery = (value: string): string => {
    let output = value;
    for (const term of preservedEntries
      .sort((a, b) => b.canonical.length - a.canonical.length)) {
      output = output.replace(
        termPattern([term.canonical, term.sourceText], "giu"),
        term.canonical,
      );
    }
    for (const term of profile.entries
      .filter((candidate) => candidate.policy === "fixed-zh" && candidate.preferredZh !== undefined)
      .sort((a, b) => b.canonical.length - a.canonical.length)) {
      output = output.replace(termPattern([term.canonical, term.sourceText], "giu"), term.preferredZh!);
    }
    for (const term of preservedEntries
      .filter((candidate) => candidate.forbiddenZh.length > 0)
      .sort((a, b) => b.forbiddenZh.join("").length - a.forbiddenZh.join("").length)) {
      for (const forbidden of term.forbiddenZh) {
        if (forbidden === "图") {
          output = replaceGraphWords(output, (match) =>
            match === forbidden ? term.canonical : match,
          );
        } else {
          output = output.replace(
            new RegExp(escapeRegExp(forbidden), "gu"),
            (match: string, offset: number, fullText: string) => {
              const previous = fullText[offset - 1] ?? "";
              const next = fullText[offset + match.length] ?? "";
              return `${HAN_CHAR_RE.test(previous) ? " " : ""}${term.canonical}${HAN_CHAR_RE.test(next) ? " " : ""}`;
            },
          );
        }
      }
    }
    return output.replace(/\s+([，。！？、：；）》】」』])/gu, "$1").replace(/([（《【「『])\s+/gu, "$1");
  };

  const prepareString = (value: string, restoration: { placeholders: { token: string; canonical: string }[] }): string => {
    if (preservedPatterns.length === 0) return value;
    return value.replace(termPattern(preservedPatterns, "giu"), (match) => {
      const token = `\uE000YT2X_TERM_${restoration.placeholders.length}\uE001`;
      restoration.placeholders.push({ token, canonical: preservedEntries.find((term) =>
        [term.canonical, term.sourceText].some((candidate) => normalizedKey(candidate) === normalizedKey(match)),
      )?.canonical ?? match });
      return token;
    });
  };

  const validateValue = <T>(value: T): readonly TechnicalTermViolation[] => {
    const violations: TechnicalTermViolation[] = [];
    const textValues: string[] = [];
    const collectTextValues = (current: unknown): void => {
      if (typeof current === "string") {
        textValues.push(current);
        return;
      }
      if (Array.isArray(current)) {
        current.forEach(collectTextValues);
      } else if (current !== null && typeof current === "object") {
        Object.values(current).forEach(collectTextValues);
      }
    };
    collectTextValues(value);
    const combinedText = textValues.join(FIELD_BOUNDARY);
    for (const text of textValues) {
      if (PRIVATE_PLACEHOLDER_RE.test(text)) {
        violations.push({ code: "unrestored-placeholder", message: "内部术语占位符残留在输出中。" });
      }
    }
    for (const term of preservedEntries) {
      if (!combinedText.includes(term.canonical)) {
        const forbidden = term.forbiddenZh.find((candidate) => combinedText.includes(candidate));
        if (forbidden !== undefined) {
          violations.push({
            code: "forbidden-translation",
            canonical: term.canonical,
            message: "输出使用了 " + forbidden + "，应保留 " + term.canonical + "。",
          });
        } else {
          violations.push({
            code: "missing-canonical-term",
            canonical: term.canonical,
            message: "输出缺少源术语 " + term.canonical + "。",
          });
        }
      }
    }
    const activeCanonicals = new Set(profile.entries.map((term) => term.canonical));
    const unexpectedMatches = TECHNICAL_TERM_CATALOG
      .flatMap((candidate) => matchesForEntry(combinedText, candidate, "sourceText"))
      .sort((a, b) => b.sourceText.length - a.sourceText.length || a.start - b.start)
      .filter((match, index, all) => all.slice(0, index).every((selected) => !overlaps(match, selected)));
    for (const match of unexpectedMatches) {
      const visualVocabularyIsAllowed = artifact === "visual-prompt"
        && match.entry.policy === "contextual-preserve";
      if (!activeCanonicals.has(match.entry.canonical) && !visualVocabularyIsAllowed) {
        violations.push({
          code: "invented-canonical-term",
          canonical: match.entry.canonical,
          message: `输出凭空加入了源材料未命中的术语 ${match.entry.canonical}。`,
        });
      }
    }
    return Object.freeze(dedupeViolations(violations));
  };

  return Object.freeze({
    profile,
    prepare<T>(value: T): PreparedTechnicalTermValue<T> {
      const restoration = { placeholders: [] as { token: string; canonical: string }[] };
      const preparedValue = replaceInValue(value, (text) => prepareString(text, restoration));
      return {
        value: preparedValue,
        promptRule,
        restoration: Object.freeze({ placeholders: Object.freeze(restoration.placeholders.map((item) => Object.freeze(item))) }),
        profileFingerprint: profile.profileFingerprint,
      };
    },
    finalize<T>(value: T, restoration: TechnicalTermRestoration): FinalizedTechnicalTermValue<T> {
      const finalizedValue = replaceInValue(value, (text) =>
        applySourceScopedRecovery(restorePlaceholders(text, restoration)),
      );
      return { value: finalizedValue, violations: validateValue(finalizedValue) };
    },
    validate<T>(value: T): readonly TechnicalTermViolation[] {
      return validateValue(value);
    },
  });
};

export const hasHardTechnicalTermViolations = (
  violations: readonly TechnicalTermViolation[],
): boolean => violations.length > 0;

export const appendTechnicalTermRuleToSystemPrompt = (
  systemPrompt: string,
  promptRule: string,
): string => [systemPrompt.trim(), promptRule.trim()].filter(Boolean).join("\n\n");

export const TECHNICAL_TERM_GENERAL_RULE =
  "源材料中实际出现的术语必须遵循其目录策略：preserve 保留 canonical 原文，必须按原文逐字保留，不得翻译、音译或本地化；fixed-zh 使用统一中文译法，contextual-preserve 只在技术语境中保留原文；不得凭空加入源材料没有的术语。";

export const buildTechnicalTermPromptRule = (language: "zh" | "en"): string => {
  const canonicals = TECHNICAL_TERM_CATALOG.map((entry) => entry.canonical).join("、");
  const contextual = TECHNICAL_TERM_CATALOG
    .filter((entry) => entry.policy === "contextual-preserve")
    .map((entry) => entry.canonical + " 只有在源材料明确作为技术概念时才需要保留原文。")
    .join("\n");
  const contextualExamples = TECHNICAL_TERM_CATALOG
    .filter((entry) => entry.policy === "contextual-preserve")
    .map((entry) => `例如「${entry.canonical} 的基本词汇」和「构建你的第一个 ${entry.canonical}」。`)
    .join("\n");
  if (language === "en") {
    return [
      "Technical-term rule: preserve source-active technical terms exactly; never translate, transliterate, or localize them.",
      "Central catalog canonicals currently covered: " + canonicals + ".",
      contextual,
      "Do not introduce catalog terms that are absent from the source.",
    ].filter(Boolean).join("\n");
  }
  return [
    "专业术语保护（硬性规则）：只保护源材料中实际出现的技术术语、方法名、框架名、模型名、产品名、命令、API 名、代码标识和可复制 prompt，必须按原文逐字保留；preserve/contextual-preserve 保留 canonical 原文，fixed-zh 使用统一中文译法；不得翻译、音译或本地化。",
    "中央目录当前覆盖的 canonical：" + canonicals + "。",
    contextual,
    contextualExamples,
    "不得凭空加入源材料没有的目录术语；普通词不因与术语同形而改写。",
  ].filter(Boolean).join("\n");
};
