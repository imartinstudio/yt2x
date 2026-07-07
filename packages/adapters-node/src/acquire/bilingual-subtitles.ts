import { parseSubtitleBlocks, serializeSrtBlocks } from "./video-subtitles.js";

export type CueAlignmentError = {
  cueIndex: number;
  message: string;
};

/**
 * Parse an SRT string and return blocks with raw text arrays,
 * without re-indexing (preserves original index numbers).
 */
const parseSrtRaw = (
  raw: string,
): Array<{ index: number; start: string; end: string; text: string[] }> => {
  return parseSubtitleBlocks(raw).map((cue) => ({
    index: cue.index,
    start: cue.start,
    end: cue.end,
    text: cue.text,
  }));
};

/** Convert SRT timestamp to milliseconds for comparison. */
const tsToMs = (ts: string): number => {
  const parts = ts.split(":");
  const h = parts[0] ?? "00";
  const m = parts[1] ?? "00";
  const rest = parts[2] ?? "00,000";
  const [s = "00", ms = "000"] = rest.split(",");
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(m, 10) * 60_000 +
    parseInt(s, 10) * 1000 +
    parseInt(ms.padEnd(3, "0").slice(0, 3), 10)
  );
};

const MAX_TIMING_DIFF_MS = 5;

/**
 * Validate that two SRT files are aligned for bilingual merging.
 *
 * Checks:
 * - Same cue count
 * - Matching cue indices
 * - Start/end times within 5ms tolerance
 * - No empty text in either language
 *
 * Returns an array of errors. An empty array means alignment is valid.
 */
export const validateCueAlignment = (
  enSrt: string,
  zhSrt: string,
): CueAlignmentError[] => {
  const enCues = parseSrtRaw(enSrt);
  const zhCues = parseSrtRaw(zhSrt);
  const errors: CueAlignmentError[] = [];

  if (enCues.length !== zhCues.length) {
    errors.push({
      cueIndex: 0,
      message: `cue count mismatch: English has ${enCues.length} cues, Chinese has ${zhCues.length} cues`,
    });
    return errors;
  }

  for (let i = 0; i < enCues.length; i++) {
    const enCue = enCues[i]!;
    const zhCue = zhCues[i]!;
    const idx = i + 1; // 1-based cue number for error messages

    const enStartMs = tsToMs(enCue.start);
    const zhStartMs = tsToMs(zhCue.start);
    if (Math.abs(enStartMs - zhStartMs) > MAX_TIMING_DIFF_MS) {
      errors.push({
        cueIndex: idx,
        message: `cue #${idx}: start time mismatch (EN ${enCue.start}, ZH ${zhCue.start}, diff ${Math.abs(enStartMs - zhStartMs)}ms)`,
      });
    }

    const enEndMs = tsToMs(enCue.end);
    const zhEndMs = tsToMs(zhCue.end);
    if (Math.abs(enEndMs - zhEndMs) > MAX_TIMING_DIFF_MS) {
      errors.push({
        cueIndex: idx,
        message: `cue #${idx}: end time mismatch (EN ${enCue.end}, ZH ${zhCue.end}, diff ${Math.abs(enEndMs - zhEndMs)}ms)`,
      });
    }

    const zhText = zhCue.text.join(" ").replace(/\s+/gu, " ").trim();
    if (zhText.length === 0) {
      errors.push({
        cueIndex: idx,
        message: `cue #${idx}: Chinese text is empty`,
      });
    }

    const enText = enCue.text.join(" ").replace(/\s+/gu, " ").trim();
    if (enText.length === 0) {
      errors.push({
        cueIndex: idx,
        message: `cue #${idx}: English text is empty`,
      });
    }
  }

  return errors;
};

/**
 * Merge English and Chinese SRT into a bilingual SRT.
 *
 * Output format:
 * - Chinese text on top (first text line)
 * - English text on bottom (second text line)
 * - Shared timing from the English cues
 *
 * Throws if cue alignment validation fails.
 */
export const mergeBilingualSrt = (enSrt: string, zhSrt: string): string => {
  const errors = validateCueAlignment(enSrt, zhSrt);
  // Empty text errors are non-fatal — mergeBilingualSrt fills gaps with English fallback
  const fatalErrors = errors.filter(
    (e) => !e.message.includes("text is empty"),
  );
  if (fatalErrors.length > 0) {
    throw new Error(
      `bilingual SRT merge failed:\n${fatalErrors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  }

  const enCues = parseSrtRaw(enSrt);
  const zhCues = parseSrtRaw(zhSrt);

  const mergedCues = enCues.map((enCue, i) => {
    const zhCue = zhCues[i]!;
    // Chinese text: collapse extra whitespace from narrow line breaks,
    // but preserve natural single spaces
    let zhText = zhCue.text.join(" ").replace(/\s+/gu, " ").trim();
    // English text: preserve natural spacing and capitalization
    const enText = enCue.text.join(" ").replace(/\s+/gu, " ").trim();

    // Fallback: if Chinese text is empty (translation gap), use English text
    if (zhText.length === 0 && enText.length > 0) {
      zhText = `[未翻译] ${enText}`;
    }

    return {
      index: enCue.index,
      start: enCue.start,
      end: enCue.end,
      text: [zhText, enText],
    };
  });

  return serializeSrtBlocks(mergedCues);
};

export type BilingualAssStyleOptions = {
  /** Chinese font family name for ASS Style */
  zhFont: string;
  /** English font family name for ASS Style */
  enFont: string;
  /** Video width for PlayResX */
  videoWidth: number;
  /** Video height for PlayResY */
  videoHeight: number;
  /** Fonts directory for ffmpeg libass (not embedded in ASS output) */
  fontsDir?: string;
};

/**
 * Convert SRT timestamp (HH:MM:SS,mmm) to ASS timestamp (H:MM:SS.cc).
 * ASS uses centiseconds (0–99), not milliseconds.
 *
 * Handles overflow: 995–999 ms round to 100 cs, which carries into
 * the next second. We convert to total centiseconds first, then
 * decompose with proper carry to avoid producing "0:00:01.100".
 */
const srtToAssTime = (srtTime: string): string => {
  const parts = srtTime.split(":");
  const h = parts[0] ?? "00";
  const m = parts[1] ?? "00";
  const rest = parts[2] ?? "00,000";
  const [s = "00", msRaw = "000"] = rest.split(",");
  const ms = parseInt(msRaw.padEnd(3, "0").slice(0, 3), 10);

  const totalCs =
    parseInt(h, 10) * 3600 * 100 +
    parseInt(m, 10) * 60 * 100 +
    parseInt(s, 10) * 100 +
    Math.round(ms / 10);

  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const outH = Math.floor(totalSec / 3600);
  const outM = Math.floor((totalSec % 3600) / 60);
  const outS = totalSec % 60;

  return `${outH}:${String(outM).padStart(2, "0")}:${String(outS).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

/**
 * Escape text for ASS Dialogue field.
 * ASS uses comma as field separator in Dialogue lines, but the text field
 * is the final field — commas within text are safe as long as they don't
 * create extra fields. We handle this by being the last field.
 *
 * Characters that need escaping in ASS:
 * - \N is ASS soft line break (we keep it)
 * - { and } are ASS override tags — escape to avoid interpretation
 */
const escapeAssText = (text: string): string => {
  return text
    .replace(/\{/gu, "\\{")
    .replace(/\}/gu, "\\}");
};

/**
 * Build a bilingual ASS subtitle file from English and Chinese SRT.
 *
 * The ASS output uses two styles:
 * - ZhTop: large yellow bold Chinese text with 3px black outline
 * - EnBottom: smaller white bold italic English text with 2px black outline
 *
 * Each cue produces two Dialogue lines with the same timing:
 * one for Chinese (ZhTop) and one for English (EnBottom).
 *
 * The Chinese line uses a higher MarginV (positioned above English).
 *
 * Throws if cue alignment validation fails.
 */
export const buildBilingualAss = (
  enSrt: string,
  zhSrt: string,
  styleOptions: BilingualAssStyleOptions,
): string => {
  const errors = validateCueAlignment(enSrt, zhSrt);
  if (errors.length > 0) {
    throw new Error(
      `bilingual ASS build failed:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  }

  const enCues = parseSrtRaw(enSrt);
  const zhCues = parseSrtRaw(zhSrt);

  const { zhFont, enFont, videoWidth, videoHeight } = styleOptions;

  // Scale font sizes and margins based on video height relative to 720p baseline
  const scale = videoHeight / 720;
  const zhFontSize = Math.round(Math.max(42, 58 * scale));
  const enFontSize = Math.round(Math.max(26, 34 * scale));
  const zhMarginV = Math.round(120 * scale);
  const enMarginV = Math.round(72 * scale);

  const lines: string[] = [];

  // [Script Info]
  lines.push("[Script Info]");
  lines.push("ScriptType: v4.00+");
  lines.push("WrapStyle: 2");
  lines.push("ScaledBorderAndShadow: yes");
  lines.push(`PlayResX: ${videoWidth}`);
  lines.push(`PlayResY: ${videoHeight}`);
  lines.push("");

  // [V4+ Styles]
  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,
  //         OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,
  //         ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,
  //         Alignment, MarginL, MarginR, MarginV, Encoding
  lines.push("[V4+ Styles]");
  lines.push(
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  );
  // ZhTop: bright yellow (BGR &H0000F4FF), black outline, bold, 3px outline
  // Alignment=2 (bottom-center)
  lines.push(
    `Style: ZhTop,${zhFont},${zhFontSize},&H0000F4FF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,${zhMarginV},1`,
  );
  // EnBottom: white (BGR &H00FFFFFF), black outline, bold italic, 2px outline
  // Alignment=2 (bottom-center)
  lines.push(
    `Style: EnBottom,${enFont},${enFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,-1,0,0,100,100,0,0,1,2,1,2,48,48,${enMarginV},1`,
  );
  lines.push("");

  // [Events]
  lines.push("[Events]");
  lines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

  for (let i = 0; i < enCues.length; i++) {
    const enCue = enCues[i]!;
    const zhCue = zhCues[i]!;

    const start = srtToAssTime(enCue.start);
    const end = srtToAssTime(enCue.end);

    const zhText = zhCue.text.join(" ").replace(/\s+/gu, " ").trim();
    const enText = enCue.text.join(" ").replace(/\s+/gu, " ").trim();

    // ZhTop: Chinese text above
    lines.push(
      `Dialogue: 0,${start},${end},ZhTop,,0,0,0,,${escapeAssText(zhText)}`,
    );
    // EnBottom: English text below
    lines.push(
      `Dialogue: 0,${start},${end},EnBottom,,0,0,0,,${escapeAssText(enText)}`,
    );
  }

  return lines.join("\n") + "\n";
};
