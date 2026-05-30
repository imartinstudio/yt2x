import type { YouTubeMetadata } from "../notes/types.js";

export type VideoShortPromptInput = {
  metadata: YouTubeMetadata;
  structuredNotesMd: string;
};

export type VideoShortPromptOptions = {
  platform?: "x";
};

export type GeneratedVideoShortPost = {
  text: string;
};
