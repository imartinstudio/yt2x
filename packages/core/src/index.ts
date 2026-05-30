export const CORE_VERSION = "0.0.0";

export * from "./domain/article/index.js";
export * from "./domain/notes/index.js";
export * from "./domain/pipeline/index.js";
export * from "./domain/publish/index.js";
export * from "./domain/quality/index.js";
export * from "./domain/short/index.js";
export * from "./domain/thread/index.js";
export * from "./domain/video-short/index.js";
export * from "./domain/visuals/index.js";
export * from "./ports/x-publish.js";
export * from "./ports/x-articles-draft.js";

export { LlmError, isLlmError } from "./ports/llm.js";
export type {
  LlmPort,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ChatRole,
  ChatUsage,
  LlmErrorKind,
  LlmErrorContext,
} from "./ports/llm.js";

export {
  DEFAULT_X_SCOPES,
  XAuthError,
} from "./ports/x-auth.js";
export type {
  XAuthPort,
  XAppConfig,
  XScope,
  OAuth2Tokens,
  StoredCredentials,
  CredentialsFileV1,
  XUserSummary,
  XAuthErrorCode,
} from "./ports/x-auth.js";
