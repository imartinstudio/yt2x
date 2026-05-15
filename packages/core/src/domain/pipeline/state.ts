import { z } from "zod";

/** CLI pipeline 四阶段顺序 */
export const PipelineStepSchema = z.enum(["acquire", "notes", "article", "publish"]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

export const STEP_ORDER: readonly PipelineStep[] = ["acquire", "notes", "article", "publish"] as const;

export const StepStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** 与 `docs/REFACTOR-PLAN.md` §4.3 对齐；`error` 为对象以承载可机读 code */
export const ProcessStatusErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type ProcessStatusError = z.infer<typeof ProcessStatusErrorSchema>;

export const StepInfoSchema = z.object({
  status: StepStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  artifacts: z.array(z.string()),
  resultFile: z.string().optional(),
  error: ProcessStatusErrorSchema.optional(),
});

export type StepInfo = z.infer<typeof StepInfoSchema>;

export const ProcessStatusV1Schema = z.object({
  version: z.literal(1),
  videoId: z.string(),
  url: z.string(),
  /** 旧文件可能缺省；读取逻辑会回填 */
  updatedAt: z.string().optional(),
  steps: z.object({
    acquire: StepInfoSchema,
    notes: StepInfoSchema,
    article: StepInfoSchema,
    publish: StepInfoSchema,
  }),
  threadUrl: z.string().optional(),
  articleOutDir: z.string().optional(),
});

export type ProcessStatusV1 = z.infer<typeof ProcessStatusV1Schema>;

export const pendingStep = (): StepInfo => ({
  status: "pending",
  artifacts: [],
});

export const createInitialProcessStatus = (input: { videoId: string; url: string; at?: string }): ProcessStatusV1 => {
  const at = input.at ?? new Date().toISOString();
  const blank = pendingStep();
  return {
    version: 1,
    videoId: input.videoId,
    url: input.url,
    updatedAt: at,
    steps: {
      acquire: { ...blank },
      notes: { ...blank },
      article: { ...blank },
      publish: { ...blank },
    },
  };
};

/** 将磁盘上的 JSON 规范化为 `ProcessStatusV1`；非 v1 时返回全新初始状态。 */
export const normalizeProcessStatusJson = (raw: unknown, identity: { videoId: string; url: string }): ProcessStatusV1 => {
  const v1 = ProcessStatusV1Schema.safeParse(raw);
  if (v1.success) return v1.data;
  return createInitialProcessStatus(identity);
};

/** NDJSON 日志行：重放时对对应 step 做覆盖写入（同 step 多行后者胜） */
export const ProcessStatusJournalLineSchema = z.object({
  v: z.literal(1),
  ts: z.string(),
  step: PipelineStepSchema,
  stepInfo: StepInfoSchema,
  threadUrl: z.string().optional(),
  articleOutDir: z.string().optional(),
});

export type ProcessStatusJournalLine = z.infer<typeof ProcessStatusJournalLineSchema>;

export const applyJournalLines = (base: ProcessStatusV1, lines: ProcessStatusJournalLine[]): ProcessStatusV1 => {
  if (lines.length === 0) return base;
  const steps = { ...base.steps };
  let threadUrl = base.threadUrl;
  let articleOutDir = base.articleOutDir;
  let updatedAt = base.updatedAt;
  for (const line of lines) {
    steps[line.step] = line.stepInfo;
    if (line.threadUrl !== undefined) threadUrl = line.threadUrl;
    if (line.articleOutDir !== undefined) articleOutDir = line.articleOutDir;
    updatedAt = line.ts;
  }
  return {
    ...base,
    steps: {
      acquire: steps.acquire,
      notes: steps.notes,
      article: steps.article,
      publish: steps.publish,
    },
    ...(threadUrl !== undefined ? { threadUrl } : {}),
    ...(articleOutDir !== undefined ? { articleOutDir } : {}),
    updatedAt,
  };
};
