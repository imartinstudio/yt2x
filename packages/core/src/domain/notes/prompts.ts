import type { NotesPromptInput, NotesPromptOptions, YouTubeMetadata } from "./types.js";

export const getNotesSystemPrompt = (options: NotesPromptOptions = {}): string => {
  const lang = options.outputLanguage ?? "zh";
  const langRule =
    lang === "en"
      ? "Output language: English"
      : "Output language: Simplified Chinese (zh-CN). Translate from the original if needed, and convert Traditional Chinese source text to Simplified Chinese. Traditional Chinese output is forbidden. This is a hard requirement.";
  const h1Rule =
    lang === "en"
      ? "# <AI semantic translation of the video title into English; if the original title is already English, keep it; do NOT add marketing hooks, clickbait prefixes, or numeric promises>"
      : "# <AI semantic translation of the video title; if the original title is not Simplified Chinese, produce a faithful semantic translation into Simplified Chinese; do NOT add marketing hooks, clickbait prefixes, or numeric promises>";
  const origTitleHint =
    lang === "en"
      ? "Original title: <original title, omit if already English>"
      : "Original title: <original title, omit if already Simplified Chinese>";

  return `You are a technical knowledge extractor. Given YouTube subtitle chunks, timestamped cues, metadata, and optional screenshot descriptions, produce a structured Markdown document.

Follow this schema exactly:

${h1Rule}

Source: <YouTube URL>
${origTitleHint}
Thumbnail: <thumbnail filename from the video directory>
Transcript source: <manual captions | auto captions>
Screenshot source: <captured keyframes | not captured>
Processed: <YYYY-MM-DD>

## Executive Summary
<One concise paragraph covering the core argument, outcome, or lesson the video delivers.>

## Topic Outline
1. <Topic name> - <what this section covers in one line>
2. <Topic name> - <what this section covers in one line>
...

## Detailed Notes
### <Topic Name>
- <Specific point, claim, example, command, or decision. Use bullet points.>
- <Preserve reusable prompts, commands, and code snippets in \`\`\`text blocks.>

### <Topic Name>
- ...

## Key Takeaways
- <Takeaway that can stand alone. A key insight or actionable lesson.>
- ...

## Screenshot References  (ONLY include this section if screenshots were actually captured)
| Timestamp | File | Why it matters |
|-----------|------|----------------|
| HH:MM:SS | scene_01.jpg | <one-line significance> |

## TODO  (ONLY include if the video content suggests concrete actions for the viewer)
- [ ] <Actionable task>

## Reusable Prompts  (ONLY include if the video contains explicit, copyable prompts)
\`\`\`text
<exact prompt>
\`\`\`

## Technical Plan  (ONLY include if the video walks through building something)
1. <Step>
2. <Step>

## Open Questions  (ONLY include if the video raises unresolved questions worth tracking)
- <Question>

Rules:
- ${langRule}
- Translate the H1 title semantically — do NOT apply prefix/suffix rules like "别再只看结论："
- The H1 title is the single most important field. It must be a faithful semantic translation of the original video title, not a marketing rewrite.
- Use ## for major section headings. Do NOT use numbered headings like "## 1. Topic".
- Include Screenshot References ONLY when screenshots were captured (screenshotsJson is non-null).
- Include TODO, Reusable Prompts, Technical Plan, Open Questions ONLY when the content genuinely warrants them. Omit sections that would be empty or generic.
- Preserve all fenced code blocks, commands, and prompts from the source.
- Do not invent facts not present in the transcript. If the source is thin on a topic, write a sharper synthesis rather than hallucinating.
- Output ONLY the Markdown document. Do not wrap it in code fences.`;
};

/** 不带价值的大字段，进 LLM 只会浪费 context */
const METADATA_DROP_KEYS: readonly string[] = [
  "formats",
  "thumbnails",
  "automatic_captions",
  "subtitles",
  "requested_formats",
  "http_headers",
  "_version",
  "_filename",
  "_type",
  "fragments",
  "manifest_url",
  "url",
];

export const stripHeavyMetadata = (meta: YouTubeMetadata): YouTubeMetadata => {
  const cleaned: YouTubeMetadata = { ...meta };
  for (const key of METADATA_DROP_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
};

/**
 * 构造 notes 阶段的 user prompt。
 * 纯函数，便于单测；输入即是已解析的素材，不再做任何 IO。
 */
export const buildNotesUserPrompt = (
  input: NotesPromptInput,
  options: NotesPromptOptions = {},
): string => {
  const meta = stripHeavyMetadata(input.metadata);

  const sections: string[] = [];
  sections.push("## Metadata");
  sections.push("```json");
  sections.push(JSON.stringify(meta, null, 2));
  sections.push("```");

  sections.push("");
  sections.push("## Transcript Chunks");
  sections.push("");
  sections.push(input.chunksMd);

  sections.push("");
  sections.push("## Timestamped Cues");
  sections.push("");
  sections.push(input.timestampedCuesMd);

  const screenshotManifest = input.screenshots ?? null;
  if (screenshotManifest !== null) {
    const frames = screenshotManifest.frames ?? screenshotManifest.screenshots ?? [];
    if (frames.length > 0) {
      sections.push("");
      sections.push("## Screenshots Captured");
      sections.push("");
      for (const frame of frames) {
        let line = `- Timestamp: ${frame.timestamp}, File: ${frame.file}`;
        if (frame.transcript_context !== undefined) {
          line += `, Context: "${frame.transcript_context}"`;
        }
        sections.push(line);
      }
    }
  }

  const lang = options.outputLanguage ?? "zh";
  const langHint =
    lang === "en"
      ? "Generate the structured-notes.md document following the schema. Output in English. Output ONLY the markdown document — no wrapper text, no code fences around the output."
      : "Generate the structured-notes.md document following the schema. Output in Simplified Chinese (zh-CN). Translate Traditional Chinese and all non-Chinese source material into Simplified Chinese. Traditional Chinese output is forbidden. This is a hard requirement. Output ONLY the markdown document — no wrapper text, no code fences around the output.";

  sections.push("");
  sections.push(langHint);

  return sections.join("\n");
};
