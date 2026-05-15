import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "./index.js";

describe("@yt2x/core skeleton", () => {
  it("exposes CORE_VERSION", () => {
    expect(typeof CORE_VERSION).toBe("string");
    expect(CORE_VERSION.length).toBeGreaterThan(0);
  });
});
