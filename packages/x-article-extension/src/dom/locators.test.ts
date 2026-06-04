import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  articleEditor,
  editorHasContent,
  findAddArticleButton,
  findImportButtonAnchor,
  findImportIconButtonAnchor,
  findImportTextButtonAnchor,
  findTitleField,
  findWriteArticleButton,
  createNewArticleDraft,
  readTitleFieldText,
  titleFieldShowsPlaceholder,
  waitForArticleDraftReady,
} from "./locators.js";

describe("x articles locators", () => {
  describe("sidebar mount", () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <nav>
          <div class="articles-row">
            <span>文章</span>
            <button type="button" aria-label="添加">+</button>
          </div>
          <div class="published-row">
            <span>已发布</span>
          </div>
        </nav>
      `;
    });

    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("finds the add button beside 文章 on the row above 已发布", () => {
      const add = findAddArticleButton();
      expect(add).not.toBeNull();
      expect(add?.getAttribute("aria-label")).toBe("添加");
      expect(findImportButtonAnchor()).toBe(add);
      expect(findImportIconButtonAnchor()).toBe(add);
    });

    it("does not use the injected import icon as the create anchor", () => {
      document.body.innerHTML = `
        <nav>
          <button id="yt2x-import-markdown-icon-btn" type="button" aria-label="新建 X Articles 草稿并导入 Markdown"></button>
          <button type="button" aria-label="create">+</button>
        </nav>
      `;
      const anchor = findImportIconButtonAnchor();
      expect(anchor?.id).not.toBe("yt2x-import-markdown-icon-btn");
      expect(anchor?.getAttribute("aria-label")).toBe("create");
    });
  });

  describe("editor", () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <main>
          <div contenteditable="true" data-placeholder="添加标题">添加标题</div>
          <div contenteditable="true" id="body" style="width:600px;height:400px">
            <p>Existing draft body with enough text for detection.</p>
          </div>
          <footer>
            <div contenteditable="true">AI Coding Workflow 探索者 bio text</div>
          </footer>
        </main>
      `;
    });

    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("finds the article body editor instead of bio footer", () => {
      const editor = articleEditor();
      expect(editor.id).toBe("body");
      expect(editorHasContent(editor)).toBe(true);
    });

    it("prefers the Draft.js article body surface when present", () => {
      document.body.innerHTML = `
        <main>
          <div contenteditable="true" data-placeholder="添加标题">添加标题</div>
          <div class="DraftEditor-root" style="width:500px;height:600px">
            <div class="DraftEditor-editorContainer">
              <div class="public-DraftEditor-content" contenteditable="true" style="width:500px;height:600px">
                <div data-contents="true">
                  <div data-block="true"><span>正文段落</span></div>
                </div>
              </div>
            </div>
          </div>
        </main>
      `;
      const editor = articleEditor();
      expect(editor.classList.contains("public-DraftEditor-content")).toBe(true);
    });

    it("finds the Chinese title placeholder field", () => {
      const title = findTitleField();
      expect(title.getAttribute("data-placeholder")).toBe("添加标题");
    });

    it("detects placeholder vs filled title text", () => {
      const title = findTitleField();
      expect(titleFieldShowsPlaceholder(title)).toBe(true);
      title.textContent = "示例标题";
      expect(titleFieldShowsPlaceholder(title)).toBe(false);
      expect(readTitleFieldText(title)).toBe("示例标题");
    });

    it("does not probe the editor toolbar while mounting the text import button", () => {
      document.body.innerHTML = `
        <main>
          <div contenteditable="true" data-placeholder="添加标题">添加标题</div>
          <div class="toolbar">
            <button type="button">添加媒体内容</button>
          </div>
          <div class="DraftEditor-root" style="width:500px;height:600px">
            <div class="DraftEditor-editorContainer">
              <div class="public-DraftEditor-content" contenteditable="true" style="width:500px;height:600px">
                <div data-contents="true">
                  <div data-block="true"><span>正文段落</span></div>
                </div>
              </div>
            </div>
          </div>
        </main>
      `;
      expect(findImportTextButtonAnchor()).toBeNull();
    });

    it("prefers the empty-state write button for the text import button", () => {
      document.body.innerHTML = `
        <main>
          <section>
            <h1>你可以在这里撰写</h1>
            <button type="button">撰写</button>
          </section>
        </main>
      `;
      const write = findWriteArticleButton();
      expect(write).toBeInstanceOf(HTMLElement);
      expect(findImportTextButtonAnchor()).toBe(write);
    });

    it("finds the link-style empty-state write control used by X", () => {
      document.body.innerHTML = `
        <main>
          <div data-yt2x-import-pair="text">
            <a href="/compose/articles" role="link">撰写</a>
            <button id="yt2x-import-markdown-text-btn" type="button">导入</button>
          </div>
        </main>
      `;
      const write = findWriteArticleButton();
      expect(write).toBeInstanceOf(HTMLAnchorElement);
      expect(findImportTextButtonAnchor()).toBe(write);
    });

    it("times out even when the page stops mutating before the draft shell appears", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = "<main></main>";

      const waiting = expect(waitForArticleDraftReady(500)).rejects.toThrow(
        "Timed out waiting for X Articles draft shell",
      );
      await vi.advanceTimersByTimeAsync(600);

      await waiting;
      vi.useRealTimers();
    });

    it("waits for the newly created draft instead of reusing the current editor", async () => {
      vi.useFakeTimers();
      const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rectMock(
        this: HTMLElement,
      ) {
        const id = this.getAttribute("id");
        const isEditor = id === "old-body" || id === "new-body";
        return {
          x: 0,
          y: 0,
          width: isEditor ? 600 : 200,
          height: isEditor ? 400 : 80,
          top: 0,
          left: 0,
          right: isEditor ? 600 : 200,
          bottom: isEditor ? 400 : 80,
          toJSON: () => ({}),
        } as DOMRect;
      });
      window.history.replaceState(null, "", "/compose/articles/edit/old");
      document.body.innerHTML = `
        <nav>
          <div><span>文章</span><button type="button" aria-label="添加">+</button></div>
        </nav>
        <main>
          <textarea placeholder="添加标题">旧标题</textarea>
          <div id="old-body" class="public-DraftEditor-content" contenteditable="true" style="width:600px;height:400px">
            旧正文内容
          </div>
        </main>
      `;
      findAddArticleButton()?.addEventListener("click", () => {
        window.setTimeout(() => {
          window.history.pushState(null, "", "/compose/articles/edit/new");
          document.body.innerHTML = `
            <nav>
              <div><span>文章</span><button type="button" aria-label="添加">+</button></div>
            </nav>
            <main>
              <textarea placeholder="添加标题"></textarea>
              <div id="new-body" class="public-DraftEditor-content" contenteditable="true" style="width:600px;height:400px"></div>
            </main>
          `;
        }, 500);
      });

      let resolved = false;
      const waiting = createNewArticleDraft().then((editor) => {
        resolved = true;
        return editor;
      });

      await vi.advanceTimersByTimeAsync(300);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      await expect(waiting).resolves.toHaveProperty("id", "new-body");
      expect(resolved).toBe(true);
      rectSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});
