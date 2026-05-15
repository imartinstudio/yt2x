# ADR-0002: LLM Provider 抽象与国内兼容

- **Status**: Accepted
- **Date**: 2026-05-14
- **Deciders**: 项目负责人
- **Tags**: llm, abstraction, i18n

## Context

### 当前实现现状（已扫码确认）

| 阶段                                      | 实现                                                                                         | LLM 依赖 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| **翻译**（structured-notes.md H1 + 内容） | `packages/adapters-node/src/notes/generator.ts` + `@yt2x/core` prompts（`createLlmAdapter`） | **必须** |
| **写文章 - rules 模式**（默认）           | `distributor.ts` 硬编码模板 + 正则规则                                                       | 不依赖   |
| **写文章 - llm 模式**（可选）             | `maybeRewriteWithLlm` 调用 OpenAI 改写 intro/summary/sections                                | 可选     |

**当前问题**（ADR 接受时；**PR-4 后大部分已解决**）：

- ~~仅支持 OpenAI / Anthropic 两家硬编码，无抽象层~~ → **`LlmPort` + `createLlmAdapter`**（OpenAI 兼容 / Anthropic / DeepSeek / Moonshot）。
- ~~国内用户无法直接用 DeepSeek / Moonshot~~ → **OpenAI 兼容 adapter**，`baseUrl` 可配。
- 无法切换本地 Ollama（**v0.2+ 待做**）。
- **主包路径**（`packages/core`、`adapters-node`、`cli`）已类型化，无 `as any` 容忍区。

### 开源后的真实需求

- 国内用户：能用 DeepSeek / Moonshot（OpenAI 兼容协议，baseUrl 替换即可）
- 进阶用户：能聚合到 OpenRouter
- 隐私用户：能挂 Ollama 本地模型
- 贡献者：能用最少代码添加新 provider

## Decision

### 1. 抽象 LlmPort 接口

```ts
// packages/core/src/ports/llm.ts
export interface LlmPort {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type ChatRequest = {
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
};

export type ChatResponse = {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
  raw?: unknown; // 调试用，可被 adapter 填充
};
```

### 2. v0.1 支持 4 个 Provider

| Provider        | 协议               | baseUrl                        | 实现成本                          |
| --------------- | ------------------ | ------------------------------ | --------------------------------- |
| OpenAI          | OpenAI Chat        | `https://api.openai.com/v1`    | 主实现                            |
| Anthropic       | Anthropic Messages | `https://api.anthropic.com/v1` | 独立 adapter                      |
| DeepSeek        | OpenAI 兼容        | `https://api.deepseek.com/v1`  | 复用 OpenAI adapter，仅换 baseUrl |
| Moonshot (Kimi) | OpenAI 兼容        | `https://api.moonshot.cn/v1`   | 复用 OpenAI adapter，仅换 baseUrl |

**v0.2+ 候选**：

- Ollama（本地）
- OpenRouter（聚合）
- Google Gemini

### 3. 实际只需要 2 个 adapter 实现

```text
packages/adapters-node/src/llm/
├─ openai-compatible.ts    # 同时覆盖 OpenAI / DeepSeek / Moonshot（baseUrl 区分）
└─ anthropic.ts            # 独立协议
```

`packages/core/src/domain/llm/factory.ts` 根据 `provider` 选择 adapter 并注入 `baseUrl`。

### 4. 严格响应 schema 校验

```ts
// packages/core/src/schema/llm.ts
export const OpenAiChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
    })
    .optional(),
});

// adapter 内
const data = OpenAiChatResponseSchema.parse(await response.json());
```

禁止 `as any`，禁止 `data?.choices?.[0]?.message?.content` 这种「乐观链式访问」。

### 5. 错误码体系

```ts
type LlmErrorCode =
  | "E_LLM_AUTH" // 401 / 403
  | "E_LLM_RATE_LIMIT" // 429
  | "E_LLM_TIMEOUT"
  | "E_LLM_BAD_RESP" // schema 校验失败
  | "E_LLM_NETWORK"
  | "E_LLM_QUOTA"; // 余额不足等
```

上层根据 code 决定重试策略：`E_LLM_RATE_LIMIT` 指数退避；`E_LLM_BAD_RESP` 不重试。

### 6. 配置加载优先级

```text
1. CLI 参数：--llm-provider --llm-model --llm-api-key --llm-base-url
2. 环境变量：OPENAI_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY / ANTHROPIC_API_KEY
3. 配置文件：~/.config/yt2x/llm.json
4. 默认：provider=openai, model=gpt-4o-mini
```

**密钥不进 argv**（与原 PLAN §5.2 一致），仅通过环境变量或配置文件。CLI 仍可传 `--llm-api-key` 但仅供 CI 临时覆盖，文档明确警告。

## Consequences

### Positive

- 国内用户开箱即用 DeepSeek / Moonshot，无需折腾代理。
- 新增 provider 只需新增一个 adapter 文件 + 注册到 factory。
- schema 校验把「API 形态变化」从「线上 silent failure」变成「明确错误」。

### Negative

- 多 provider 测试矩阵增加（但 OpenAI 兼容三家共享同一实现，实际只测 2 套）。
- 用户配置面增加：需要在 README 明确说明每家的 env var 和 model 名称。

### Neutral

- 写文章的 LLM 模式仍保持「可选」，v0.1 默认走 rules（与现状一致），避免开源用户首次试用必须填 API key 才能跑。

## Open Questions

- 是否在 `notes` 阶段也允许 `--no-llm` 模式（用 yt-dlp 字幕直出，跳过翻译）？  
  → 倾向：不允许。翻译质量与术语统一是 yt2x 的核心价值。若用户不需要翻译，用 yt-dlp 即可。

## Alternatives Considered

### Option A: 继续硬编码 OpenAI + Anthropic

- **缺点**：国内用户难用，违反开源「最大化可达性」原则。
- **否决原因**：扩展到国内市场是开源后的明确目标。

### Option B: 只做一个 OpenAI 兼容 client，用户自配 baseUrl

- **优点**：代码最少。
- **缺点**：Anthropic 不能用，且每家 provider 的 model 名、错误码、限流策略不同，"看似通用"的代码会在边界 case 翻车。
- **否决原因**：协议兼容 ≠ 行为兼容。Anthropic 必须独立 adapter。

### Option C: 直接用 LangChain.js / LlamaIndex 之类的库

- **优点**：开箱支持几十家 provider。
- **缺点**：体积大、抽象层太厚、依赖升级风险大。
- **否决原因**：我们只需要 chat 一个能力，自写 50 行就够，不值得引入。

## References

- DeepSeek API: <https://platform.deepseek.com/api-docs>
- Moonshot API: <https://platform.moonshot.cn/docs>
- Anthropic Messages API: <https://docs.anthropic.com/en/api/messages>
- 相关：ADR-0001（packages 分层）
