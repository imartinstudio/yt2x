import { describe, expect, it } from "vitest";
import {
  allocateBoundariesByChars,
  CUE_HARD_WIDTH,
  splitEnglishByShares,
  splitUtteranceIntoCues,
  splitZhByWidth,
  visualWidth,
} from "./cue-split.js";

describe("visualWidth", () => {
  it("counts CJK as 1 cell and Latin/digit as 0.5 cell", () => {
    expect(visualWidth("你好")).toBe(2);
    expect(visualWidth("ab")).toBe(1);
    expect(visualWidth("你ab好")).toBe(3);
  });

  it("does not count punctuation", () => {
    expect(visualWidth("你，好。")).toBe(2);
  });
});

describe("splitZhByWidth", () => {
  it("returns empty array for blank text", () => {
    expect(splitZhByWidth("")).toEqual([]);
    expect(splitZhByWidth("   ")).toEqual([]);
  });

  it("keeps a single character as one part", () => {
    expect(splitZhByWidth("好")).toEqual(["好"]);
  });

  it("keeps short text under the width ceiling as one part", () => {
    const zh = "这是一句不长的中文配音稿";
    expect(visualWidth(zh)).toBeLessThanOrEqual(CUE_HARD_WIDTH);
    expect(splitZhByWidth(zh)).toEqual([zh]);
  });

  it("splits a long sentence so every part stays within the hard width ceiling", () => {
    const zh =
      "这是一句非常非常长的中文配音稿，用来测试屏宽切分是否能够把它拆成好几条显示单元，" +
      "并且保证每一条都不会超过屏幕能显示的最大宽度。";
    const parts = splitZhByWidth(zh);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(visualWidth(part)).toBeLessThanOrEqual(CUE_HARD_WIDTH);
    }
  });

  it("never drops or duplicates characters when splitting", () => {
    const zh =
      "第一部分讲的是背景知识，第二部分讲的是具体做法，第三部分则是一些常见的坑，" +
      "希望大家看完之后能够少走弯路，用最短的时间掌握这套方法。";
    const parts = splitZhByWidth(zh);
    expect(parts.join("")).toBe(zh);
  });

  it("never carves off a lone trailing punctuation mark as its own part (real-data regression)", () => {
    // 真实成片复现过的 bug：目标位置附近没有标点，搜索半径一路扫到句子自己的结尾
    // 句号，把它当成"最近的强标点"选中，切出一条只有单个「。」的显示单元。
    const zh = "这些技能的核心就是不断追问你，一直问到你达成共识为止。";
    const parts = splitZhByWidth(zh);
    expect(parts).toEqual(["这些技能的核心就是不断追问你，", "一直问到你达成共识为止。"]);
    for (const part of parts) {
      // 每一片去掉标点后至少有实质内容，不是孤零零一个标点符号
      expect(part.replace(/[，。！？、；：,.!?;:]/gu, "").length).toBeGreaterThan(0);
    }
  });

  it("never produces a part shorter than 2 characters when a split happens", () => {
    const samples = [
      "这些技能的核心就是不断追问你，一直问到你达成共识为止。",
      "在正式开始之前我们先聊聊这个环节具体是怎么运作的呢，然后再讲讲后面的安排。",
      "第一部分讲的是背景知识，第二部分讲的是具体做法，第三部分则是一些常见的坑。",
    ];
    for (const zh of samples) {
      for (const part of splitZhByWidth(zh)) {
        expect(part.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("never splits inside a protected glossary term", () => {
    // "Grill with Docs" 前后各垫一些字符，让默认目标宽度落在术语内部附近
    const zh = "在正式开始之前我们先聊聊 Grill with Docs 这个环节具体是怎么运作的呢";
    const parts = splitZhByWidth(zh, 12);
    for (const part of parts) {
      if (part.includes("Grill")) {
        expect(part).toContain("Grill with Docs");
      }
    }
  });
});

describe("allocateBoundariesByChars", () => {
  it("splits the time range proportionally to each part's character count", () => {
    // "AA" 2 字符, "BBBB" 4 字符 -> 1:2 比例
    const boundaries = allocateBoundariesByChars(["AA", "BBBB"], 0, 900);
    expect(boundaries[0]).toBe(0);
    expect(boundaries[1]).toBe(300);
    expect(boundaries[2]).toBe(900);
  });

  it("never drifts past the utterance's own endMs regardless of rounding", () => {
    const boundaries = allocateBoundariesByChars(["甲", "乙", "丙", "丁", "戊"], 1000, 1007);
    expect(boundaries[0]).toBe(1000);
    expect(boundaries[boundaries.length - 1]).toBe(1007);
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i]!).toBeGreaterThan(boundaries[i - 1]!);
    }
  });

  it("returns a single span covering the whole range for one part", () => {
    expect(allocateBoundariesByChars(["整句"], 500, 2000)).toEqual([500, 2000]);
  });
});

describe("splitEnglishByShares", () => {
  it("splits English text by word boundary proportional to zh char shares", () => {
    const en = "one two three four five six";
    const parts = splitEnglishByShares(en, ["AA", "AA"]); // even 1:1 split -> 3 words each
    expect(parts).toEqual(["one two three", "four five six"]);
  });

  it("never splits a word and reconstructs the original text exactly", () => {
    const en = "And what that does is it relies on the skill of the person answering the questions.";
    const parts = splitEnglishByShares(en, ["一二三", "四五", "六七八九"]);
    expect(parts.join(" ").replace(/\s+/gu, " ").trim()).toBe(en);
  });

  it("returns empty strings for every part when the source text is empty", () => {
    expect(splitEnglishByShares("", ["AA", "BB"])).toEqual(["", ""]);
  });

  it("returns the whole text unsplit for a single zh part", () => {
    expect(splitEnglishByShares("hello world", ["整句"])).toEqual(["hello world"]);
  });
});

describe("splitUtteranceIntoCues", () => {
  it("returns a single cue spanning the whole utterance when the zh text fits one screen line", () => {
    const cues = splitUtteranceIntoCues({
      zhText: "这是一句短句子",
      enText: "This is a short sentence.",
      startMs: 1000,
      endMs: 2500,
    });
    expect(cues).toEqual([
      {
        index: 1,
        zhText: "这是一句短句子",
        enText: "This is a short sentence.",
        startMs: 1000,
        endMs: 2500,
      },
    ]);
  });

  it("returns an empty array for blank zh text", () => {
    expect(splitUtteranceIntoCues({ zhText: "  ", enText: "hi", startMs: 0, endMs: 100 })).toEqual(
      [],
    );
  });

  it("does not drift inside the utterance: cues are contiguous and span exactly [startMs, endMs]", () => {
    const zhText =
      "这是一句非常非常长的中文配音稿，用来测试屏宽切分是否能够把它拆成好几条显示单元，" +
      "并且保证每一条都不会超过屏幕能显示的最大宽度，同时时间也应该按字符比例精确分配。";
    const enText =
      "This is a very long dubbed sentence meant to test whether width-based splitting " +
      "can break it into several display cues, each staying within the screen's max width, " +
      "while time is allocated exactly proportional to character share.";
    const cues = splitUtteranceIntoCues({ zhText, enText, startMs: 10_000, endMs: 18_500 });

    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.startMs).toBe(10_000); // 第一条起点等于话语单元实测起点，不引入起点漂移
    expect(cues[cues.length - 1]!.endMs).toBe(18_500); // 最后一条终点封口在实测终点
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.startMs).toBe(cues[i - 1]!.endMs); // 相邻显示单元首尾相接，没有空隙也没有重叠
    }
    // 中文内容原样拼回，没有丢字也没有重复
    expect(cues.map((c) => c.zhText).join("")).toBe(zhText);
  });

  it("keeps every part's visual width within the hard ceiling", () => {
    const zhText =
      "这是一句非常非常长的中文配音稿，用来测试屏宽切分是否能够把它拆成好几条显示单元，" +
      "并且保证每一条都不会超过屏幕能显示的最大宽度。";
    const cues = splitUtteranceIntoCues({
      zhText,
      enText: "a long english source sentence that pairs with the long chinese dub script",
      startMs: 0,
      endMs: 8000,
    });
    for (const cue of cues) {
      expect(visualWidth(cue.zhText)).toBeLessThanOrEqual(CUE_HARD_WIDTH);
    }
  });

  it("assigns the same single character its whole utterance span", () => {
    const cues = splitUtteranceIntoCues({ zhText: "好", enText: "OK.", startMs: 0, endMs: 300 });
    expect(cues).toEqual([{ index: 1, zhText: "好", enText: "OK.", startMs: 0, endMs: 300 }]);
  });
});
