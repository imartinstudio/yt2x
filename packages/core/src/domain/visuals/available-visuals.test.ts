import { describe, expect, it } from "vitest";
import { manifestToAvailableVisuals } from "./available-visuals.js";
import type { SceneManifest } from "./types.js";

const makeFrame = (overrides: Record<string, unknown> = {}) => ({
  id: "scene_001",
  timestamp: "00:01:23",
  seconds: 83,
  file: "scene_01_00-01-23.jpg",
  transcript_context: "测试上下文",
  selection_reason: "scene_change",
  visual_quality: {
    blur: "low" as const,
    blur_score: 0.95,
    has_text: true,
    has_ui: true,
    center_presenter: false,
    usable_for_content: true,
  },
  ...overrides,
});

const makeManifest = (frames: ReturnType<typeof makeFrame>[]): SceneManifest => ({
  source: "https://example.com",
  method: "ffmpeg_scene_detection_stream",
  frames,
});

describe("manifestToAvailableVisuals", () => {
  it("returns empty array for null manifest", () => {
    expect(manifestToAvailableVisuals(null)).toEqual([]);
  });

  it("returns empty array for manifest with no frames", () => {
    expect(manifestToAvailableVisuals(makeManifest([]))).toEqual([]);
  });

  it("returns empty array when frames is undefined", () => {
    expect(
      manifestToAvailableVisuals({ source: "", method: "" } as SceneManifest),
    ).toEqual([]);
  });

  it("converts a valid frame to available visual", () => {
    const result = manifestToAvailableVisuals(makeManifest([makeFrame()]));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      visual_id: "scene_001",
      path: "screenshots/scene_01_00-01-23.jpg",
      timestamp: "00:01:23",
      nearby_text: "测试上下文",
      quality: {
        blur: "low",
        has_text: true,
        has_ui: true,
        center_presenter: false,
      },
    });
  });

  it("filters out blur: high frames", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({
          visual_quality: {
            blur: "high",
            has_text: true,
            has_ui: true,
            center_presenter: false,
            usable_for_content: true,
          },
        }),
      ]),
    );
    expect(result).toHaveLength(0);
  });

  it("filters out blur: unknown frames", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({
          visual_quality: {
            blur: "unknown",
            has_text: true,
            has_ui: true,
            center_presenter: false,
            usable_for_content: true,
          },
        }),
      ]),
    );
    expect(result).toHaveLength(0);
  });

  it("filters out center_presenter: true frames", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({
          visual_quality: {
            blur: "low",
            blur_score: 0.95,
            has_text: true,
            has_ui: true,
            center_presenter: true,
            usable_for_content: true,
          },
        }),
      ]),
    );
    expect(result).toHaveLength(0);
  });

  it("filters out usable_for_content: false frames", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({
          visual_quality: {
            blur: "low",
            blur_score: 0.95,
            has_text: true,
            has_ui: true,
            center_presenter: false,
            usable_for_content: false,
          },
        }),
      ]),
    );
    expect(result).toHaveLength(0);
  });

  it("filters out frames with no visual_quality", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        {
          id: "scene_001",
          timestamp: "00:01:23",
          seconds: 83,
          file: "scene_01_00-01-23.jpg",
          transcript_context: "",
          selection_reason: "scene_change",
          visual_quality: undefined as unknown as ReturnType<typeof makeFrame>["visual_quality"],
        },
      ]),
    );
    expect(result).toHaveLength(0);
  });

  it("only passes frames that meet all quality criteria", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({ id: "scene_001" }),
        makeFrame({
          id: "scene_002",
          visual_quality: {
            blur: "high",
            has_text: true,
            has_ui: true,
            center_presenter: false,
            usable_for_content: true,
          },
        }),
        makeFrame({
          id: "scene_003",
          visual_quality: {
            blur: "medium",
            has_text: false,
            has_ui: true,
            center_presenter: false,
            usable_for_content: true,
          },
        }),
        makeFrame({ id: "scene_004" }),
      ]),
    );
    expect(result).toHaveLength(3);
    expect(result.map((v) => v.visual_id)).toEqual(["scene_001", "scene_003", "scene_004"]);
  });

  it("prepends screenshots/ to file path when missing", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({ file: "scene_01_00-01-23.jpg" }),
      ]),
    );
    expect(result[0]!.path).toBe("screenshots/scene_01_00-01-23.jpg");
  });

  it("does not double-prepend screenshots/ path", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({ file: "screenshots/scene_01_00-01-23.jpg" }),
      ]),
    );
    expect(result[0]!.path).toBe("screenshots/scene_01_00-01-23.jpg");
  });

  it("handles empty transcript_context", () => {
    const result = manifestToAvailableVisuals(
      makeManifest([
        makeFrame({ transcript_context: "" }),
      ]),
    );
    expect(result[0]!.nearby_text).toBe("");
  });
});
