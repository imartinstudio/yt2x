import { describe, expect, it } from "vitest";
import { getNotesSystemPrompt, buildNotesUserPrompt, stripHeavyMetadata } from "./prompts.js";
import type { NotesPromptInput, YouTubeMetadata } from "./types.js";

const baseInput: NotesPromptInput = {
  metadata: {
    id: "abc",
    title: "Hello",
    webpage_url: "https://youtu.be/abc",
    channel: "TestChan",
    description: "desc",
  },
  chunksMd: "## Chunk 1\nfirst part",
  timestampedCuesMd: "00:00 — hello\n00:05 — world",
  screenshots: null,
};

describe("getNotesSystemPrompt", () => {
  it("defaults to Chinese output language", () => {
    const prompt = getNotesSystemPrompt();
    expect(prompt).toMatch(/Output language: Simplified Chinese/);
    expect(prompt).toMatch(/zh-CN/);
    expect(prompt).toMatch(/Traditional Chinese source text to Simplified Chinese/);
    expect(prompt).not.toMatch(/Output language: English/);
  });

  it("uses English when outputLanguage is 'en'", () => {
    const prompt = getNotesSystemPrompt({ outputLanguage: "en" });
    expect(prompt).toMatch(/Output language: English/);
    expect(prompt).toMatch(/into English/);
    expect(prompt).not.toMatch(/Chinese/);
  });

  it("contains the H1 + Source contract", () => {
    const prompt = getNotesSystemPrompt();
    expect(prompt).toMatch(/# <AI semantic translation/);
    expect(prompt).toMatch(/Source: <YouTube URL>/);
  });

  it("requires conditional sections", () => {
    const prompt = getNotesSystemPrompt();
    expect(prompt).toMatch(/ONLY include this section if screenshots/);
    expect(prompt).toMatch(/ONLY include if the video content/);
  });
});

describe("stripHeavyMetadata", () => {
  it("removes the predefined heavy keys but keeps useful fields", () => {
    const meta: YouTubeMetadata = {
      id: "abc",
      title: "t",
      formats: [{ a: 1 }],
      thumbnails: [{ url: "x" }],
      automatic_captions: { en: [] },
      requested_formats: [],
      _filename: "x.mp4",
      description: "keep",
    };
    const cleaned = stripHeavyMetadata(meta);
    expect(cleaned.id).toBe("abc");
    expect(cleaned.description).toBe("keep");
    expect(cleaned.formats).toBeUndefined();
    expect(cleaned.thumbnails).toBeUndefined();
    expect(cleaned.automatic_captions).toBeUndefined();
    expect(cleaned.requested_formats).toBeUndefined();
    expect(cleaned._filename).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const meta: YouTubeMetadata = { id: "abc", formats: [{ a: 1 }] };
    stripHeavyMetadata(meta);
    expect(meta.formats).toBeDefined();
  });
});

describe("buildNotesUserPrompt", () => {
  it("includes metadata JSON, transcript chunks and cues in order", () => {
    const prompt = buildNotesUserPrompt(baseInput);
    const metaIdx = prompt.indexOf("## Metadata");
    const chunksIdx = prompt.indexOf("## Transcript Chunks");
    const cuesIdx = prompt.indexOf("## Timestamped Cues");
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(chunksIdx).toBeGreaterThan(metaIdx);
    expect(cuesIdx).toBeGreaterThan(chunksIdx);
  });

  it("omits Screenshots Captured section when no screenshots", () => {
    const prompt = buildNotesUserPrompt(baseInput);
    expect(prompt).not.toMatch(/## Screenshots Captured/);
  });

  it("includes Screenshots Captured section from manifest.frames", () => {
    const prompt = buildNotesUserPrompt({
      ...baseInput,
      screenshots: {
        frames: [
          { timestamp: "00:00:05", file: "scene_01.jpg" },
          { timestamp: "00:00:42", file: "scene_02.jpg", transcript_context: "demo starts" },
        ],
      },
    });
    expect(prompt).toMatch(/## Screenshots Captured/);
    expect(prompt).toMatch(/scene_01\.jpg/);
    expect(prompt).toMatch(/Context: "demo starts"/);
  });

  it("falls back to manifest.screenshots alias", () => {
    const prompt = buildNotesUserPrompt({
      ...baseInput,
      screenshots: { screenshots: [{ timestamp: "00:00:01", file: "f.jpg" }] },
    });
    expect(prompt).toMatch(/f\.jpg/);
  });

  it("skips empty screenshots array (no section heading)", () => {
    const prompt = buildNotesUserPrompt({
      ...baseInput,
      screenshots: { frames: [] },
    });
    expect(prompt).not.toMatch(/## Screenshots Captured/);
  });

  it("treats undefined screenshots like null (no section heading)", () => {
    const { screenshots: _drop, ...withoutScreenshots } = baseInput;
    const prompt = buildNotesUserPrompt(withoutScreenshots);
    expect(prompt).not.toMatch(/## Screenshots Captured/);
  });

  it("strips heavy metadata fields from the JSON blob", () => {
    const prompt = buildNotesUserPrompt({
      ...baseInput,
      metadata: {
        ...baseInput.metadata,
        formats: [{ a: 1 }],
        automatic_captions: { en: [] },
      },
    });
    expect(prompt).not.toMatch(/"formats"/);
    expect(prompt).not.toMatch(/"automatic_captions"/);
  });

  it("ends with explicit 'output ONLY the markdown' instruction", () => {
    const prompt = buildNotesUserPrompt(baseInput);
    expect(prompt.trimEnd()).toMatch(/Output ONLY the markdown document/);
  });

  it("defaults to Chinese output instruction", () => {
    const prompt = buildNotesUserPrompt(baseInput);
    expect(prompt).not.toMatch(/Output in English/);
    expect(prompt).toMatch(/Output in Simplified Chinese \(zh-CN\)/);
    expect(prompt).toMatch(/Translate Traditional Chinese/);
  });

  it("includes English output instruction when outputLanguage is 'en'", () => {
    const prompt = buildNotesUserPrompt(baseInput, { outputLanguage: "en" });
    expect(prompt).toMatch(/Output in English/);
  });
});
