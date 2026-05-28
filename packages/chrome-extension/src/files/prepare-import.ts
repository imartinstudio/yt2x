import {
  adaptArticleForX,
  parseArticleDraftFromMarkdown,
  type AdaptArticleForXResult,
  type ArticleDraftParseResult,
  type ArticleForXAdaptation,
  type XArticleSubscriptionTier,
} from "@yt2x/core";
import type { MediaRegistry } from "./local-media.js";
import { renderMermaidToPngBlob } from "../render/mermaid-image.js";
import { renderTableMarkdownToPngBlob } from "../render/table-image.js";

export type PreparedArticleImport = {
  parseResult: ArticleDraftParseResult;
  adapted: AdaptArticleForXResult;
  mediaRegistry: MediaRegistry;
  generatedBlobs: Map<string, Blob>;
};

const isTableAdaptation = (
  adaptation: ArticleForXAdaptation,
): adaptation is ArticleForXAdaptation & { placeholder: string; sourceMarkdown: string } =>
  adaptation.kind === "premium-table" &&
  adaptation.placeholder !== undefined &&
  adaptation.sourceMarkdown !== undefined;

const MERMAID_BLOCK_RE = /```mermaid\n([\s\S]*?)```/giu;

const materializeMermaidBlocks = async (
  markdown: string,
  generatedBlobs: Map<string, Blob>,
): Promise<string> => {
  const matches = [...markdown.matchAll(MERMAID_BLOCK_RE)];
  let output = markdown;
  let index = 0;
  for (const match of matches) {
    const source = match[1]?.trim() ?? "";
    if (source.length === 0) {
      throw new Error("Mermaid block was empty and cannot be converted.");
    }
    index += 1;
    const placeholder = `yt2x-mermaid-${index}.png`;
    const blob = await renderMermaidToPngBlob(source);
    generatedBlobs.set(placeholder, blob);
    output = output.replace(match[0]!, `![Mermaid diagram](${placeholder})`);
  }
  return output;
};

export const prepareArticleImport = async (input: {
  markdown: string;
  subscriptionTier: XArticleSubscriptionTier;
  mediaRegistry: MediaRegistry;
}): Promise<PreparedArticleImport> => {
  const generatedBlobs = new Map<string, Blob>();
  const withMermaid = await materializeMermaidBlocks(input.markdown, generatedBlobs);
  const adapted = adaptArticleForX({
    markdown: withMermaid,
    subscriptionTier: input.subscriptionTier,
  });

  for (const table of adapted.adaptations.filter(isTableAdaptation)) {
    const blob = await renderTableMarkdownToPngBlob(table.sourceMarkdown);
    generatedBlobs.set(table.placeholder!, blob);
  }

  const parseResult = parseArticleDraftFromMarkdown(adapted.markdown, {
    resolveMediaPath: (source) => input.mediaRegistry.resolveMediaPath(source),
    preserveSourceContent: true,
    omitDividers: true,
  });
  const missingCoverSources =
    parseResult.coverImage === null || input.mediaRegistry.getUploadable(parseResult.coverImage) !== undefined
      ? []
      : input.mediaRegistry.missingSources.filter(
          (source) => input.mediaRegistry.resolveMediaPath(source) === parseResult.coverImage,
        );
  if (missingCoverSources.length > 0) {
    throw new Error(`Missing authorized cover media: ${missingCoverSources.join(", ")}`);
  }

  return {
    parseResult,
    adapted,
    mediaRegistry: input.mediaRegistry,
    generatedBlobs,
  };
};

export const resolveUploadFile = (
  prepared: PreparedArticleImport,
  resolvedPath: string,
): File | undefined => {
  const generated = prepared.generatedBlobs.get(resolvedPath);
  if (generated !== undefined) {
    return new File([generated], resolvedPath, { type: "image/png" });
  }
  return prepared.mediaRegistry.getUploadable(resolvedPath);
};
