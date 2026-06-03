import { afterEach, describe, expect, it } from "vitest";
import {
  IMPORT_BUTTON_PAIR_ATTR,
  alignImportIconPair,
  ensureImportTextPair,
  importIconMarkup,
  styleImportButton,
} from "./import-button-style.js";

describe("import button style", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("styles the icon button as a native transparent X toolbar control", () => {
    document.body.innerHTML = `
      <div id="toolbar">
        <button class="x-create" type="button" aria-label="create"></button>
      </div>
    `;
    const anchor = document.querySelector("button") as HTMLButtonElement;
    const button = document.createElement("button");
    button.innerHTML = importIconMarkup;

    styleImportButton(button, anchor, "icon");
    anchor.insertAdjacentElement("beforebegin", button);
    alignImportIconPair(anchor, button);

    expect(button.className).toBe("x-create");
    expect(button.style.width).toBe("36px");
    expect(button.style.height).toBe("36px");
    expect(button.style.background).toBe("transparent");
    expect(button.style.color).toBe("rgb(231, 233, 234)");
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("24");
    expect(button.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(button.querySelectorAll("path")).toHaveLength(3);
    expect(button.parentElement?.style.flexDirection).toBe("row");
    expect(button.nextElementSibling).toBe(anchor);
  });

  it("applies hover without adding a focus outline to the icon button", () => {
    const anchor = document.createElement("button");
    const button = document.createElement("button");
    styleImportButton(button, anchor, "icon");

    button.dispatchEvent(new MouseEvent("mouseenter"));
    expect(button.style.backgroundColor).toBe("rgba(239, 243, 244, 0.12)");

    button.dispatchEvent(new MouseEvent("mouseleave"));
    expect(button.style.backgroundColor).toBe("transparent");

    button.dispatchEvent(new FocusEvent("focus"));
    expect(button.style.outline).toBe("");
    expect(button.style.outlineOffset).toBe("");

    button.dispatchEvent(new FocusEvent("blur"));
    expect(button.style.outline).toBe("");
  });

  it("styles the text button as a pure-white pill beside the write control", () => {
    document.body.innerHTML = `
      <main>
        <a href="/compose/articles" role="link">撰写</a>
      </main>
    `;
    const anchor = document.querySelector("a") as HTMLElement;
    const button = document.createElement("button");
    button.textContent = "导入";

    styleImportButton(button, anchor, "text");
    ensureImportTextPair(anchor, button);

    const pair = anchor.closest(`[${IMPORT_BUTTON_PAIR_ATTR}]`) as HTMLElement;
    expect(pair).toBeInstanceOf(HTMLElement);
    expect(pair.style.display).toBe("flex");
    expect(pair.style.flexDirection).toBe("row");
    expect(pair.style.flexWrap).toBe("nowrap");
    expect(anchor.nextElementSibling).toBe(button);
    expect(button.style.height).toBe("52px");
    expect(button.style.background).toBe("rgb(255, 255, 255)");
    expect(button.style.color).toBe("rgb(15, 20, 25)");
    expect(button.style.borderRadius).toBe("9999px");
    expect(button.style.outline).toBe("none");
    button.dispatchEvent(new FocusEvent("focus"));
    expect(button.style.outline).toBe("");
    expect(button.textContent).toBe("导入");
  });
});
