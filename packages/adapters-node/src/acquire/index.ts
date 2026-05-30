export {
  executeNativeAcquire,
  DEFAULT_NATIVE_ACQUIRE_TIMEOUT_MS,
  type NativeAcquireOptions,
  type NativeAcquireStageModes,
} from "./execute-native-acquire.js";
export {
  type AcquireProgressCallbacks,
  type AcquireSubStepProgress,
} from "./acquire-progress.js";
export { prepareYoutubeVideo, type PrepareYoutubeVideoOptions } from "./prepare-youtube-video.js";
export { parseSubtitleCues, cuesToMarkdown, type SubtitleCue } from "./subtitle-to-cues.js";
export { transcriptToChunksMarkdown, type TranscriptChunk } from "./clean-chunk-transcript.js";
export {
  collectNativePipelineVideoIds,
  listBatchVideosFromOutRoot,
  resolveAcquireVideoQueue,
  validateArtifacts,
  type ResolveAcquireQueueInput,
} from "./batch-queue.js";
export { resolveVideoSources, extractVideoId, type VideoSourceRow } from "./resolve-sources.js";
export { sanitizeVideoId } from "./video-id-from-url.js";
export {
  runSubtitlePipeline,
  prepareSourceSubtitle,
  type RunSubtitlePipelineOptions,
  type RunSubtitlePipelineResult,
  type VideoSubtitleOptions,
  type SubtitleManifest,
  type SubtitleSourceMode,
  type SubtitleSourceMethod,
  type TranscriptionRunner,
} from "./video-subtitles.js";
export { translateSrt, type SrtTranslatorOptions } from "./srt-translator.js";
export {
  burnSubtitles,
  validateSrtIntegrity,
  verifyBurnedSubtitles,
  type BurnSubtitlesOptions,
  type SrtIntegrityIssue,
  type VerificationResult,
} from "./burn-subtitles.js";
export { detectBurnedSubtitles, type DetectBurnedSubtitlesResult } from "./detect-burned-subs.js";
