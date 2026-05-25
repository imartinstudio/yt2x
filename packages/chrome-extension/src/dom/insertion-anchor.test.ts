import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateInsertionAnchor,
  focusInsertionAnchor,
  normalizeAnchorText,
} from "./insertion-anchor.js";

describe("insertion-anchor", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="editor" contenteditable="true">
        <p>Intro</p>
        <p>示例提示: follow-up line</p>
        <h2>Section</h2>
      </div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("normalizes fullwidth colons for matching", () => {
    expect(normalizeAnchorText("示例提示：")).toBe("示例提示:");
  });

  it("focuses the anchor occurrence closest to the target block index", () => {
    const editor = document.getElementById("editor") as HTMLElement;
    editor.insertAdjacentHTML(
      "beforeend",
      "<p>示例提示: early</p><p>示例提示: late</p>",
    );
    focusInsertionAnchor(editor, "示例提示: early", 0, 5);
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    const range = selection!.getRangeAt(0);
    expect(range.startContainer.textContent).toContain("early");
  });

  it("activates Draft.js blocks via data-block anchors", () => {
    const editor = document.getElementById("editor") as HTMLElement;
    editor.innerHTML = `
      <div data-contents="true">
        <div data-block="true"><span>示例提示: target</span></div>
        <div data-block="true"><span>其它段落</span></div>
      </div>
    `;
    const target = editor.querySelector("[data-block='true']") as HTMLElement;
    const clicked = vi.fn();
    target.addEventListener("click", clicked);
    activateInsertionAnchor(editor, "示例提示: target", 0, 2);
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    const range = selection!.getRangeAt(0);
    expect(range.endContainer.textContent).toContain("target");
    expect(clicked).toHaveBeenCalled();
  });

  it("signals Draft.js selection changes after activating an insertion anchor", () => {
    const editor = document.getElementById("editor") as HTMLElement;
    const selectionChanged = vi.fn();
    const selected = vi.fn();
    document.addEventListener("selectionchange", selectionChanged);
    editor.addEventListener("select", selected);

    activateInsertionAnchor(editor, "Intro", 0, 3);

    expect(selectionChanged).toHaveBeenCalled();
    expect(selected).toHaveBeenCalled();
  });

  it("falls back to block index when anchor text is missing", () => {
    const editor = document.getElementById("editor") as HTMLElement;
    focusInsertionAnchor(editor, "missing anchor", 0, 3);
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    const range = selection!.getRangeAt(0);
    expect((range.endContainer as HTMLElement).textContent).toContain("Intro");
  });
});
