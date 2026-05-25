import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  findButtonByName,
  findGenericInsertButton,
  isGenericInsertButtonLabel,
  LOCALE_PATTERNS,
} from "./locators.js";

describe("insert button routing", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <div id="toolbar">
          <button type="button" aria-label="添加媒体内容">Add media</button>
          <button type="button" aria-label="Insert">+</button>
          <button type="button">插入</button>
        </div>
        <div contenteditable="true" id="editor">Body</div>
      </main>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = "";
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
});
