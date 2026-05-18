import { describe, expect, it } from "vitest";
import {
  ARTICLE_LEAD_MAX_CHARS,
  ARTICLE_MAX_CONSECUTIVE_PARAGRAPHS,
  ARTICLE_PARAGRAPH_MAX_CHARS,
  EXECUTABLE_ASSET_KEYWORDS,
  FORBIDDEN_AUTHOR_PHRASES,
  HIGH_TRUST_TOPIC_KEYWORDS,
  RISK_SECTION_KEYWORDS,
  SHORT_LIST_MAX_ITEMS,
  SHORT_LIST_MIN_ITEMS,
  SUMMARY_TONE_PHRASES,
  THREAD_FIRST_TWEET_FORBIDDEN_PREFIXES,
  THREAD_MAX_TWEETS,
  THREAD_MIN_TWEETS,
  THREAD_TWEET_MAX_CHARS,
  detectHighTrustTopics,
  matchesAny,
} from "./rules.js";

describe("rules constants", () => {
  it("article thresholds are sane positive integers", () => {
    expect(ARTICLE_LEAD_MAX_CHARS).toBe(120);
    expect(ARTICLE_PARAGRAPH_MAX_CHARS).toBeGreaterThan(ARTICLE_LEAD_MAX_CHARS);
    expect(ARTICLE_MAX_CONSECUTIVE_PARAGRAPHS).toBeGreaterThanOrEqual(2);
  });

  it("short list bounds are aligned with spec (4-6)", () => {
    expect(SHORT_LIST_MIN_ITEMS).toBe(4);
    expect(SHORT_LIST_MAX_ITEMS).toBe(6);
  });

  it("thread bounds are aligned with spec (6-10)", () => {
    expect(THREAD_MIN_TWEETS).toBe(6);
    expect(THREAD_MAX_TWEETS).toBe(10);
    expect(THREAD_TWEET_MAX_CHARS).toBe(500);
  });

  it("forbidden author phrases include 视频作者", () => {
    expect(FORBIDDEN_AUTHOR_PHRASES).toContain("视频作者");
  });

  it("summary-tone phrases include common offenders", () => {
    expect(SUMMARY_TONE_PHRASES).toContain("本视频介绍");
    expect(SUMMARY_TONE_PHRASES).toContain("总结一下");
  });

  it("risk section keywords cover 风险 / 边界", () => {
    expect(RISK_SECTION_KEYWORDS).toContain("风险");
    expect(RISK_SECTION_KEYWORDS).toContain("边界");
  });

  it("executable asset keywords cover all asset kinds", () => {
    expect(Object.keys(EXECUTABLE_ASSET_KEYWORDS).sort()).toEqual(
      ["checklist", "decision-tree", "prompt", "risk-list", "steps", "template"].sort(),
    );
  });

  it("thread first-tweet forbidden prefixes cover 1/ and 本视频", () => {
    expect(THREAD_FIRST_TWEET_FORBIDDEN_PREFIXES).toContain("1/");
    expect(THREAD_FIRST_TWEET_FORBIDDEN_PREFIXES).toContain("本视频");
  });
});

describe("matchesAny", () => {
  it("is case insensitive and matches substrings", () => {
    expect(matchesAny("Hello OAuth Token here", ["oauth"])).toBe(true);
    expect(matchesAny("无关文本", ["oauth"])).toBe(false);
  });
});

describe("detectHighTrustTopics", () => {
  it("returns empty array for neutral content", () => {
    const topics = detectHighTrustTopics("讲一下 yt-dlp 怎么用");
    expect(topics).toEqual([]);
  });

  it("detects account + payment for Apple ID + 礼品卡 scenario", () => {
    const text = "如何注册外区 Apple ID 并用礼品卡充值。";
    const topics = detectHighTrustTopics(text);
    expect(topics).toContain("account");
    expect(topics).toContain("payment");
  });

  it("detects credentials for OAuth / cookies / API key", () => {
    expect(detectHighTrustTopics("使用 OAuth 授权登录")).toContain("credentials");
    expect(detectHighTrustTopics("把浏览器 cookies 复制过来")).toContain("credentials");
    expect(detectHighTrustTopics("生成一个 API Key")).toContain("credentials");
  });

  it("detects automation for 自动发布 / 自动删除", () => {
    expect(detectHighTrustTopics("用脚本自动发布到 X")).toContain("automation");
    expect(detectHighTrustTopics("批量删除历史推文")).toContain("automation");
  });

  it("does not duplicate topics", () => {
    const text = "Apple ID 外区账号注册、外区 Apple ID 教程";
    const topics = detectHighTrustTopics(text);
    expect(topics.filter((t) => t === "account").length).toBe(1);
  });
});

describe("HIGH_TRUST_TOPIC_KEYWORDS", () => {
  it("declares keyword arrays for every topic", () => {
    expect(HIGH_TRUST_TOPIC_KEYWORDS.account.length).toBeGreaterThan(0);
    expect(HIGH_TRUST_TOPIC_KEYWORDS.payment.length).toBeGreaterThan(0);
    expect(HIGH_TRUST_TOPIC_KEYWORDS.credentials.length).toBeGreaterThan(0);
    expect(HIGH_TRUST_TOPIC_KEYWORDS.automation.length).toBeGreaterThan(0);
  });
});
