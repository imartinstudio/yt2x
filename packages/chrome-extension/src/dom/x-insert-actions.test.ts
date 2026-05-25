import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findButtonByName,
  findGenericInsertButton,
  isGenericInsertButtonLabel,
  LOCALE_PATTERNS,
} from "./locators.js";
import {
  isCoverFileInput,
  precedingContentBlockIndex,
  prepareClipboardImage,
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

  it("uses a PNG clipboard blob when the source image is JPEG", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 4_000, height: 1_000, close }),
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const png = new Blob(["converted"], { type: "image/png" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(png);
    });

    const result = await prepareClipboardImage(
      new File(["jpeg"], "scene.jpg", { type: "image/jpeg" }),
    );

    expect(result).toBe(png);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2_000, 500);
    expect(close).toHaveBeenCalled();
  });
});
