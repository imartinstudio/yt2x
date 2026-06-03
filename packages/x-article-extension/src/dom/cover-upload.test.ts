import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCoverFileInput, findCoverUploadButton } from "./cover-upload.js";

describe("cover-upload", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="hero" style="height:120px">
        <button type="button" aria-label="添加照片或视频">Cover add</button>
        <input id="cover-input" type="file" />
      </div>
      <div contenteditable="true" data-placeholder="添加标题" style="margin-top:200px">添加标题</div>
      <main>
        <button type="button" aria-label="添加媒体内容">Body media</button>
        <input id="body-input" type="file" />
        <div contenteditable="true" id="editor" style="height:300px">Body</div>
      </main>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("targets cover controls above the title field, not body media controls", () => {
    const coverButton = findCoverUploadButton();
    expect(coverButton?.getAttribute("aria-label")).toBe("添加照片或视频");

    const coverInput = findCoverFileInput();
    expect(coverInput?.id).toBe("cover-input");
    expect(coverInput?.id).not.toBe("body-input");
  });
});
