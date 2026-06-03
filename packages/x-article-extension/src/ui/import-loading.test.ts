import { afterEach, describe, expect, it } from "vitest";
import { formatIndexedStep, showImportLoading } from "./import-loading.js";

describe("import-loading", () => {
  afterEach(() => {
    document.querySelector("[data-yt2x-import-loading]")?.remove();
    document.documentElement.removeAttribute("data-yt2x-import-busy");
  });

  it("formats indexed step labels", () => {
    expect(formatIndexedStep("正在插入图片", 2, 5)).toBe("正在插入图片（2/5）");
    expect(formatIndexedStep("正在插入图片", 1, 1)).toBe("正在插入图片");
  });

  it("shows and updates loading overlay", () => {
    const loading = showImportLoading("步骤一");
    const host = document.querySelector("[data-yt2x-import-loading]");
    expect(host).not.toBeNull();
    expect(document.documentElement.getAttribute("data-yt2x-import-busy")).toBe("true");

    loading.update("步骤二");
    const message = host?.shadowRoot?.querySelector("[data-role='message']");
    expect(message?.textContent).toBe("步骤二");

    loading.close();
    expect(document.querySelector("[data-yt2x-import-loading]")).toBeNull();
    expect(document.documentElement.getAttribute("data-yt2x-import-busy")).toBeNull();
  });
});
