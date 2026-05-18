import { describe, expect, it } from "vitest";
import {
  ABSTRACT_FRAMEWORK_FIXTURE,
  CONTENT_QUALITY_FIXTURES,
  GENERAL_TOOL_FIXTURE,
  HIGH_TRUST_FIXTURE,
} from "./fixtures.js";
import { detectHighTrustTopics } from "./rules.js";
import type { ContentQualityFixture } from "./types.js";

const FORBIDDEN_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/,
  /AKIA[A-Z0-9]{8,}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /xoxb-[A-Za-z0-9-]+/,
  /xoxp-[A-Za-z0-9-]+/,
  /OAuth[\s_-]+[A-Za-z0-9._-]{20,}/i,
  /AIzaSy[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
];

const isPlaceholderVideoId = (id: string): boolean => /^fx-[a-z0-9-]+$/.test(id);

const assertFixtureCleanliness = (fx: ContentQualityFixture): void => {
  expect(isPlaceholderVideoId(fx.id), `fixture ${fx.id} must be a placeholder id`).toBe(true);
  expect(fx.metadata.id).toBe(fx.id);
  expect(fx.metadata.webpage_url).toMatch(/<YOUTUBE_URL>/);
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    expect(
      pattern.test(fx.structuredNotesMd),
      `fixture ${fx.id} structured notes should not match ${pattern}`,
    ).toBe(false);
  }
};

describe("CONTENT_QUALITY_FIXTURES", () => {
  it("exposes exactly three categories covering required scenarios", () => {
    const ids = CONTENT_QUALITY_FIXTURES.map((fx) => fx.id);
    expect(ids).toContain(HIGH_TRUST_FIXTURE.id);
    expect(ids).toContain(ABSTRACT_FRAMEWORK_FIXTURE.id);
    expect(ids).toContain(GENERAL_TOOL_FIXTURE.id);

    const categories = new Set(CONTENT_QUALITY_FIXTURES.map((fx) => fx.category));
    expect(categories.size).toBe(3);
    expect(categories.has("high-trust-tutorial")).toBe(true);
    expect(categories.has("abstract-framework")).toBe(true);
    expect(categories.has("general-tool-tutorial")).toBe(true);
  });

  it("each fixture is placeholder-safe and free from common secrets", () => {
    for (const fx of CONTENT_QUALITY_FIXTURES) {
      assertFixtureCleanliness(fx);
    }
  });

  it("each fixture provides Article / Short / Thread expectations", () => {
    for (const fx of CONTENT_QUALITY_FIXTURES) {
      expect(fx.expectations.article).toBeDefined();
      expect(fx.expectations.short).toBeDefined();
      expect(fx.expectations.thread).toBeDefined();
      expect(fx.expectations.article.hookElements.length).toBeGreaterThanOrEqual(1);
      expect(fx.expectations.short.hookElements.length).toBeGreaterThanOrEqual(1);
      expect(fx.expectations.thread.hookElements.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("high-trust fixture expectations align with detected topics", () => {
    const detected = detectHighTrustTopics(
      `${HIGH_TRUST_FIXTURE.metadata.title ?? ""}\n${HIGH_TRUST_FIXTURE.structuredNotesMd}`,
    );
    expect(detected.length).toBeGreaterThan(0);
    for (const topic of HIGH_TRUST_FIXTURE.expectations.article.highTrustTopics) {
      expect(detected).toContain(topic);
    }
    expect(HIGH_TRUST_FIXTURE.expectations.article.requiresRiskSection).toBe(true);
    expect(HIGH_TRUST_FIXTURE.expectations.short.requiresRiskSection).toBe(true);
    expect(HIGH_TRUST_FIXTURE.expectations.thread.requiresRiskSection).toBe(true);
  });

  it("non high-trust fixtures do not request a risk section", () => {
    expect(ABSTRACT_FRAMEWORK_FIXTURE.expectations.article.requiresRiskSection).toBe(false);
    expect(GENERAL_TOOL_FIXTURE.expectations.article.requiresRiskSection).toBe(false);
  });

  it("each fixture requests at least one executable asset kind per target", () => {
    for (const fx of CONTENT_QUALITY_FIXTURES) {
      expect(fx.expectations.article.executableAssetKinds.length).toBeGreaterThanOrEqual(1);
      expect(fx.expectations.short.executableAssetKinds.length).toBeGreaterThanOrEqual(1);
      expect(fx.expectations.thread.executableAssetKinds.length).toBeGreaterThanOrEqual(1);
    }
  });
});
