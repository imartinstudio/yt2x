import { describe, expect, it } from "vitest";
import { createInitialProcessStatus, normalizeProcessStatusJson } from "./state.js";

describe("normalizeProcessStatusJson", () => {
  const identity = { videoId: "abc123", url: "https://www.youtube.com/watch?v=abc123" };

  it("parses v1 process-status", () => {
    const initial = createInitialProcessStatus(identity);
    const parsed = normalizeProcessStatusJson(initial, identity);
    expect(parsed.version).toBe(1);
    expect(parsed.videoId).toBe("abc123");
    expect(parsed.steps.acquire.status).toBe("pending");
  });

  it("returns fresh v1 when JSON is not v1 schema", () => {
    const nonV1 = {
      steps: {
        acquire: { status: "done", artifacts: ["chunks.md"], updated_at: "2020-01-01T00:00:00.000Z" },
      },
    };
    const parsed = normalizeProcessStatusJson(nonV1, identity);
    expect(parsed.version).toBe(1);
    expect(parsed.steps.acquire.status).toBe("pending");
    expect(parsed.videoId).toBe("abc123");
  });
});
