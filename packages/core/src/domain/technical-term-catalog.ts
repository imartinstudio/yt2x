export type TechnicalTermPolicy = "preserve" | "fixed-zh" | "contextual-preserve";
export type TechnicalTermArtifact = "content" | "visual-prompt";
export type TechnicalTermForbiddenTranslationHandling = "recover" | "reject";

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
  forbiddenTranslationHandling?: TechnicalTermForbiddenTranslationHandling;
};

export type DiscoveredTechnicalTerm = {
  sourceText: string;
  confidence: "high" | "medium" | "low";
  category: TechnicalTermCategory;
};

export type TechnicalTermDiscoveryWarningRecord = {
  code: string;
  message: string;
  sourceText?: string;
};

/**
 * 可随 TechnicalTermProfile 一起落盘的 discovery 审计摘要。
 *
 * 这里不依赖 adapter 的具体 warning 枚举，保证 profile 仍然是可序列化的
 * core contract；adapter 可以把自己的 machine-readable warning 原样放进来。
 */
export type TechnicalTermDiscoveryAudit = {
  promptVersion: string;
  /** Stable identity of the source title/text used for discovery; optional for legacy reads. */
  sourceIdentity?: string;
  acceptedCandidates: readonly DiscoveredTechnicalTerm[];
  reviewCandidates: readonly DiscoveredTechnicalTerm[];
  warnings: readonly TechnicalTermDiscoveryWarningRecord[];
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
  forbiddenTranslationHandling: TechnicalTermForbiddenTranslationHandling;
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
  discovery: TechnicalTermDiscoveryAudit;
  sourceUnitId?: string;
  profileFingerprint: string;
};

export type TechnicalTermSourceUnit = {
  sourceText: string;
  sourceTitle?: string;
  unitId?: string;
};

/** A unit scope must carry an explicit stable id so callers cannot accidentally validate a whole source. */
export type TechnicalTermScopedSourceUnit = Omit<TechnicalTermSourceUnit, "unitId"> & {
  unitId: string;
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
  /** 从父档案派生一个必须按 unitId 与 occurrence count 校验的 cue/field/translation-unit 作用域。 */
  scopeUnit(sourceUnit: TechnicalTermScopedSourceUnit): TechnicalTermGuard;
  /** 从同一源级 profile 派生一个 cue/field/translation-unit 作用域。 */
  scope(sourceUnit: TechnicalTermSourceUnit | string, sourceTitle?: string): TechnicalTermGuard;
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
const GRAPH_VISUAL_CONTEXT_RE =
  /(?:\b(?:diagram|image|visual|chart|plot|flowchart|figure|screenshot|illustration|picture)\b[\s\S]{0,36}\bgraph\b|\bgraph\b[\s\S]{0,36}\b(?:diagram|image|visual|chart|plot|flowchart|figure|screenshot|illustration|picture)\b)/iu;
const GRAPH_MIXED_VISUAL_CONTEXT_RE =
  /(?:(?:图片|图表|示意图|流程图|图像|图形)[\s\S]{0,24}\bgraph\b|\bgraph\b[\s\S]{0,24}(?<!不)(?:是|为|展示|显示|一张|一幅)[\s\S]{0,16}(?:图片|图表|示意图|流程图|图像|图形))/iu;
const GRAPH_TECHNICAL_CONTEXT_RE =
  /(?:\b(?:build|create|construct|use|using|useful|helps|explain|worth|starts|first|basic|vocabulary|technical|concept|schema|database|algorithm|node|edge|traversal|query|retrieval|workflow|reasoning|engineering|system|model|structure|RAG)\b[\s\S]{0,40}\bgraph\b|\bgraph\b[\s\S]{0,40}\b(?:build|create|construct|use|using|useful|helps|explain|worth|starts|first|basic|vocabulary|technical|concept|schema|database|algorithm|node|edge|traversal|query|retrieval|workflow|reasoning|engineering|system|model|structure|RAG)\b)/iu;
const GRAPH_MIXED_TECHNICAL_CONTEXT_RE =
  /(?:\bgraph\b[\s\S]{0,28}(?:能|可以|用于|表示|连接|包含|节点|边|检索|推理|依赖|不是|并非)|(?:构建|创建|使用|技术|概念|数据库|算法|节点|边|检索|推理|依赖|工作流|系统|模型|结构)[\s\S]{0,28}\bgraph\b)/iu;
const GRAPH_CHINESE_TECHNICAL_CONTEXT_RE =
  /(?:图的基本词汇|第[一二三四五六七八九十\d]+个图|现成的图|值得用图|更大的图|图(?:是|能|可以|用于|表示|连接|包含|节点|边|数据库|算法|结构|工作流|检索|推理))/u;
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
  forbiddenTranslationHandling: entry.forbiddenTranslationHandling ?? "reject",
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
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
};

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/** Synchronous SHA-256 for stable core fingerprints; does not require Node crypto. */
export const sha256Hex = (value: string): string => {
  const input = new TextEncoder().encode(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(schedule[index - 15]!, 7)
        ^ rotateRight(schedule[index - 15]!, 18)
        ^ (schedule[index - 15]! >>> 3);
      const s1 = rotateRight(schedule[index - 2]!, 17)
        ^ rotateRight(schedule[index - 2]!, 19)
        ^ (schedule[index - 2]! >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index]! + schedule[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
};

export const fingerprintTechnicalTermValue = (value: unknown): string =>
  `sha256-${sha256Hex(stableSerialize(value))}`;

const catalogFingerprintValue = (entries: readonly TechnicalTermEntry[]) =>
  entries
    .map((entry) => ({
      canonical: entry.canonical,
      aliases: [...entry.aliases].sort((a, b) => normalizedKey(a).localeCompare(normalizedKey(b))),
      categories: [...entry.categories].sort(),
      policy: entry.policy,
      preferredZh: entry.preferredZh,
      forbiddenZh: [...(entry.forbiddenZh ?? [])].sort(),
      forbiddenTranslationHandling: entry.forbiddenTranslationHandling ?? "reject",
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
    if (entry.policy === "preserve" && entry.preferredZh?.trim()) {
      throw new Error(`conflicting-term-policy: preserve term ${entry.canonical} cannot declare preferredZh`);
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
    fingerprint: fingerprintTechnicalTermValue(catalogFingerprintValue(entries)),
  });
};

const entry = (
  canonical: string,
  categories: readonly TechnicalTermCategory[],
  policy: TechnicalTermPolicy = "preserve",
  options: Partial<Pick<TechnicalTermEntry, "aliases" | "preferredZh" | "forbiddenZh" | "forbiddenTranslationHandling">> = {},
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
    forbiddenTranslationHandling: "recover",
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

const isTechnicalGraphContext = (text: string, start: number, end: number): boolean => {
  const surrounding = text.slice(Math.max(0, start - 64), Math.min(text.length, end + 64));
  if (GRAPH_VISUAL_CONTEXT_RE.test(surrounding) || GRAPH_MIXED_VISUAL_CONTEXT_RE.test(surrounding)) return false;
  return GRAPH_TECHNICAL_CONTEXT_RE.test(surrounding) || GRAPH_MIXED_TECHNICAL_CONTEXT_RE.test(surrounding);
};

const isTechnicalChineseGraphContext = (text: string, offset: number): boolean => {
  const surrounding = text.slice(Math.max(0, offset - 24), Math.min(text.length, offset + 32));
  return GRAPH_CHINESE_TECHNICAL_CONTEXT_RE.test(surrounding);
};

const isActiveGraphMatch = (match: TermMatch, text: string): boolean =>
  match.entry.canonical !== "Graph" || isTechnicalGraphContext(text, match.start, match.end);

const overlaps = (a: TermMatch, b: TermMatch): boolean => a.start < b.end && b.start < a.end;

const findProfileMatches = (
  sourceText: string,
  sourceTitle: string,
  discoveredTerms: readonly DiscoveredTechnicalTerm[],
  catalogEntries: readonly TechnicalTermEntry[],
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
  const allEntries = [...catalogEntries, ...discoveredEntries];
  const selectLongestMatches = (matches: TermMatch[]): TermMatch[] => [...matches]
    .sort((a, b) => b.sourceText.length - a.sourceText.length || a.start - b.start)
    .filter((match, index, all) => all.slice(0, index).every((selected) => !overlaps(match, selected)));
  const sourceMatches = selectLongestMatches(
    allEntries
      .flatMap((candidate) => matchesForEntry(sourceText, candidate, "sourceText"))
      .filter((match) => isActiveGraphMatch(match, sourceText)),
  );
  const titleMatches = selectLongestMatches(
    allEntries
      .flatMap((candidate) => matchesForEntry(sourceTitle, candidate, "sourceTitle"))
      .filter((match) => isActiveGraphMatch(match, sourceTitle)),
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
      forbiddenTranslationHandling: match.entry.forbiddenTranslationHandling ?? "reject",
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
  return {
    sourceFingerprint: "",
    entries,
    occurrences,
    discovery: {
      promptVersion: "unspecified",
      acceptedCandidates: [],
      reviewCandidates: [],
      warnings: [],
    },
    profileFingerprint: "",
  };
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
    if (!isTechnicalChineseGraphContext(fullText, offset)) return match;
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
  termCatalog: TechnicalTermCatalog,
  discovery: TechnicalTermDiscoveryAudit | undefined,
  sourceUnitId: string | undefined,
): TechnicalTermProfile => {
  const sourceIdentity = discovery?.sourceIdentity
    ?? fingerprintTechnicalTermValue({ sourceTitle, sourceText });
  const discoveryAudit: TechnicalTermDiscoveryAudit = {
    promptVersion: discovery?.promptVersion ?? "unspecified",
    sourceIdentity,
    acceptedCandidates: Object.freeze([...(discovery?.acceptedCandidates ?? discoveredTerms)]),
    reviewCandidates: Object.freeze([...(discovery?.reviewCandidates ?? [])]),
    warnings: Object.freeze([...(discovery?.warnings ?? [])]),
  };
  const matches = findProfileMatches(
    sourceText,
    sourceTitle,
    discovery?.acceptedCandidates ?? discoveredTerms,
    termCatalog.entries,
  );
  const base = resolvedFromMatches(matches);
  const contextualMatches = termCatalog.entries
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
  const sourceFingerprint = fingerprintTechnicalTermValue({ sourceText, sourceTitle, sourceUnitId });
  return Object.freeze({
    sourceFingerprint,
    entries: mergedEntries,
    occurrences: base.occurrences,
    discovery: Object.freeze({
      promptVersion: discoveryAudit.promptVersion,
      sourceIdentity,
      acceptedCandidates: Object.freeze(discoveryAudit.acceptedCandidates.map((candidate) => Object.freeze({ ...candidate }))),
      reviewCandidates: Object.freeze(discoveryAudit.reviewCandidates.map((candidate) => Object.freeze({ ...candidate }))),
      warnings: Object.freeze(discoveryAudit.warnings.map((warning) => Object.freeze({ ...warning }))),
    }),
    ...(sourceUnitId === undefined ? {} : { sourceUnitId }),
    profileFingerprint: fingerprintTechnicalTermValue({
      sourceFingerprint,
      activeEntries: mergedEntries,
      occurrences: base.occurrences,
      artifact,
      discoveryVersion: discoveryAudit.promptVersion,
      sourceIdentity,
      acceptedCandidates: discoveryAudit.acceptedCandidates,
      sourceUnitId,
    }),
  });
};

export type CreateTechnicalTermGuardArgs = {
  sourceText: string;
  sourceTitle?: string;
  discoveredTerms?: readonly DiscoveredTechnicalTerm[];
  discovery?: TechnicalTermDiscoveryAudit;
  artifact?: TechnicalTermArtifact;
  catalog?: TechnicalTermCatalog;
  sourceUnitId?: string;
};

export const createTechnicalTermGuard = ({
  sourceText,
  sourceTitle = "",
  discoveredTerms = [],
  discovery: discoveryAudit,
  artifact = "content",
  catalog: termCatalog = catalog,
  sourceUnitId,
}: CreateTechnicalTermGuardArgs): TechnicalTermGuard => {
  const profile = createProfile(
    sourceText,
    sourceTitle,
    discoveredTerms,
    artifact,
    termCatalog,
    discoveryAudit,
    sourceUnitId,
  );
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
        (match: string, _captured: string, offset: number, fullText: string) => term.canonical === "Graph"
          && !isTechnicalGraphContext(fullText, offset, offset + match.length)
          ? match
          : term.canonical,
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
    return value.replace(termPattern(preservedPatterns, "giu"), (match: string, _captured: string, offset: number, fullText: string) => {
      const matchedTerm = preservedEntries.find((term) =>
        [term.canonical, term.sourceText].some((candidate) => normalizedKey(candidate) === normalizedKey(match)),
      );
      if (matchedTerm?.canonical === "Graph" && !isTechnicalGraphContext(fullText, offset, offset + match.length)) {
        return match;
      }
      const token = `\uE000YT2X_TERM_${restoration.placeholders.length}\uE001`;
      restoration.placeholders.push({ token, canonical: matchedTerm?.canonical ?? match });
      return token;
    });
  };

  const countTermOccurrences = (text: string, term: string): number =>
    [...text.matchAll(termPattern([term], "giu"))]
      .filter((match) => {
        const start = match.index ?? 0;
        const lineStart = Math.max(text.lastIndexOf("\n", start), text.lastIndexOf(" ", start)) + 1;
        const lineEndCandidate = text.slice(start).search(/[\s]/u);
        const lineEnd = lineEndCandidate < 0 ? text.length : start + lineEndCandidate;
        return !/^https?:\/\/[^\s]+$/iu.test(text.slice(lineStart, lineEnd));
      })
      .length;

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
      const occurrenceCount = profile.occurrences.filter((occurrence) => occurrence.canonical === term.canonical).length;
      const expectedCount = profile.sourceUnitId === undefined ? Math.min(occurrenceCount, 1) : occurrenceCount;
      const actualCount = countTermOccurrences(combinedText, term.canonical);
      if (actualCount < expectedCount) {
        const forbidden = term.forbiddenZh.find((candidate) => candidate === "图"
          ? [...combinedText.matchAll(/图/gu)].some((match) => isTechnicalChineseGraphContext(combinedText, match.index))
          : countTermOccurrences(combinedText, candidate) > 0);
        if (forbidden !== undefined) {
          violations.push({
            code: "forbidden-translation",
            canonical: term.canonical,
            message: `输出使用了 ${forbidden}，应保留 ${term.canonical}；源中出现 ${expectedCount} 次。`,
          });
        } else {
          violations.push({
            code: "missing-canonical-term",
            canonical: term.canonical,
            message: `输出缺少源术语 ${term.canonical}（源中出现 ${expectedCount} 次，当前 ${actualCount} 次）。`,
          });
        }
      }
    }
    const activeCanonicals = new Set(profile.entries.map((term) => term.canonical));
    const unexpectedMatches = termCatalog.entries
      .flatMap((candidate) => matchesForEntry(combinedText, candidate, "sourceText"))
      .filter((match) => isActiveGraphMatch(match, combinedText))
      .sort((a, b) => b.sourceText.length - a.sourceText.length || a.start - b.start)
      .filter((match, index, all) => all.slice(0, index).every((selected) => !overlaps(match, selected)));
    for (const match of unexpectedMatches) {
      const visualVocabularyIsAllowed = artifact === "visual-prompt"
        && match.entry.canonical === "Graph"
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
    scopeUnit(sourceUnit: TechnicalTermScopedSourceUnit): TechnicalTermGuard {
      return createTechnicalTermGuard({
        sourceText: sourceUnit.sourceText,
        ...(sourceUnit.sourceTitle === undefined ? {} : { sourceTitle: sourceUnit.sourceTitle }),
        discoveredTerms: profile.discovery.acceptedCandidates,
        discovery: profile.discovery,
        artifact,
        catalog: termCatalog,
        sourceUnitId: sourceUnit.unitId,
      });
    },
    scope(sourceUnit: TechnicalTermSourceUnit | string, scopedSourceTitle = ""): TechnicalTermGuard {
      const normalizedUnit = typeof sourceUnit === "string"
        ? { sourceText: sourceUnit, sourceTitle: scopedSourceTitle }
        : sourceUnit;
      return createTechnicalTermGuard({
        sourceText: normalizedUnit.sourceText,
        ...(normalizedUnit.sourceTitle === undefined ? {} : { sourceTitle: normalizedUnit.sourceTitle }),
        discoveredTerms: profile.discovery.acceptedCandidates,
        discovery: profile.discovery,
        artifact,
        catalog: termCatalog,
        ...(normalizedUnit.unitId === undefined ? {} : { sourceUnitId: normalizedUnit.unitId }),
      });
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

export const buildTechnicalTermPromptRule = (
  language: "zh" | "en",
  activeTerms: readonly ResolvedTechnicalTerm[] = [],
): string => {
  const canonicals = activeTerms.map((entry) => entry.canonical).join("、");
  const contextual = activeTerms
    .filter((entry) => entry.policy === "contextual-preserve")
    .map((entry) => entry.canonical + " 只有在源材料明确作为技术概念时才需要保留原文。")
    .join("\n");
  const contextualExamples = activeTerms
    .filter((entry) => entry.policy === "contextual-preserve")
    .map((entry) => `例如「${entry.canonical} 的基本词汇」和「构建你的第一个 ${entry.canonical}」。`)
    .join("\n");
  if (language === "en") {
    return [
      "Technical-term rule: preserve source-active technical terms exactly; never translate, transliterate, or localize them.",
      canonicals === "" ? "No source-active technical terms were detected." : "Source-active canonicals: " + canonicals + ".",
      contextual,
      "Do not introduce catalog terms that are absent from the source.",
    ].filter(Boolean).join("\n");
  }
  return [
    "专业术语保护（硬性规则）：只保护源材料中实际出现的技术术语、方法名、框架名、模型名、产品名、命令、API 名、代码标识和可复制 prompt，必须按原文逐字保留；preserve/contextual-preserve 保留 canonical 原文，fixed-zh 使用统一中文译法；不得翻译、音译或本地化。",
    canonicals === "" ? "本次源材料没有命中目录术语。" : "本次源材料激活的 canonical：" + canonicals + "。",
    contextual,
    contextualExamples,
    "不得凭空加入源材料没有的目录术语；普通词不因与术语同形而改写。",
  ].filter(Boolean).join("\n");
};
