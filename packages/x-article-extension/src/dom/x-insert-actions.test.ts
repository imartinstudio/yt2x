import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findButtonByName,
  findGenericInsertButton,
  isGenericInsertButtonLabel,
  LOCALE_PATTERNS,
} from "./locators.js";
import {
  insertDivider,
  isCoverFileInput,
  precedingContentBlockIndex,
} from "./x-insert-actions.js";

describe("insert button routing", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <div id="toolbar">
          <button type="button" aria-label="添加媒体内容">Add media</button>
          <input id="body-input" type="file" />
          <button type="button" aria-label="Insert">+</button>
          <button type="button">插入</button>
        </div>
        <div id="cover">
          <button type="button" aria-label="添加照片或视频">Cover media</button>
          <input id="cover-input" type="file" />
        </div>
        <div contenteditable="true" id="editor">Body</div>
      </main>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches add-media and generic insert as different controls", () => {
    const addMedia = findButtonByName(LOCALE_PATTERNS.insertAddMedia);
    const insert = findGenericInsertButton();
    expect(addMedia?.getAttribute("aria-label")).toBe("添加媒体内容");
    expect(insert?.textContent === "插入" || insert?.getAttribute("aria-label") === "Insert").toBe(
      true,
    );
    expect(addMedia).not.toBe(insert);
  });

  it("accepts aria-label Insert while excluding add media labels", () => {
    expect(isGenericInsertButtonLabel("Insert")).toBe(true);
    expect(isGenericInsertButtonLabel("添加媒体内容")).toBe(false);
  });

  it("excludes only the cover input, not a body-media input in the toolbar", () => {
    const coverInput = document.querySelector("#cover-input");
    const bodyInput = document.querySelector("#body-input");
    expect(coverInput).toBeInstanceOf(HTMLInputElement);
    expect(bodyInput).toBeInstanceOf(HTMLInputElement);
    expect(isCoverFileInput(coverInput as HTMLInputElement)).toBe(true);
    expect(isCoverFileInput(bodyInput as HTMLInputElement)).toBe(false);
  });

  it("maps the media preceding-block count to the block receiving the paste caret", () => {
    expect(precedingContentBlockIndex(0)).toBe(0);
    expect(precedingContentBlockIndex(1)).toBe(0);
    expect(precedingContentBlockIndex(3)).toBe(2);
  });

  it("inserts a divider through the visible add-media content menu used by X Articles", async () => {
    document.querySelectorAll("#toolbar button:not([aria-label='添加媒体内容'])").forEach((node) => {
      node.remove();
    });
    const addMedia = document.querySelector<HTMLButtonElement>("button[aria-label='添加媒体内容']");
    let clickedDivider = false;
    addMedia?.addEventListener("click", () => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = "分割线";
      item.addEventListener("click", () => {
        clickedDivider = true;
      });
      document.body.appendChild(item);
    });

    await expect(insertDivider()).resolves.toBe(true);
    expect(clickedDivider).toBe(true);
  });
});
