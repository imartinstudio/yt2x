import type { ArticleDraftParseResult } from "../domain/publish/article-draft.js";

export type SaveArticleDraftInput = {
  parseResult: ArticleDraftParseResult;
  articleDir: string;
  headless?: boolean;
  browserProfileDir?: string;
  timeoutMs?: number;
};

export type SaveArticleDraftResult = {
  draftSavedAt: string;
  editorUrl?: string;
  warnings: string[];
};

export interface XArticlesDraftPort {
  saveDraft(input: SaveArticleDraftInput): Promise<SaveArticleDraftResult>;
}
