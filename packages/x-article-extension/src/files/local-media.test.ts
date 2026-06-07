import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMediaRegistry, pickMarkdownFile } from "./local-media.js";

const file = (name: string, relativePath?: string): File =>
  new File(["x"], name, {
    type: "image/png",
    ...(relativePath === undefined
      ? {}
      : { lastModified: Date.now() }),
  });

describe("buildMediaRegistry", () => {
  it("maps relative image paths from authorized directory files", () => {
    const cover = file("cover.png");
    Object.defineProperty(cover, "webkitRelativePath", {
      value: "images/cover.png",
      configurable: true,
    });
    const registry = buildMediaRegistry({
      markdown: "# T\n\n![cover](images/cover.png)\n",
      authorizedFiles: [cover],
    });

    expect(registry.missingSources).toEqual([]);
    expect(registry.getUploadable("images/cover.png")).toBe(cover);
  });

  it("reports missing sources when media is not authorized", () => {
    const registry = buildMediaRegistry({
      markdown: "![shot](images/missing.png)",
      authorizedFiles: [],
    });
    expect(registry.missingSources).toEqual(["images/missing.png"]);
  });
});

describe("pickMarkdownFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects before clicking hidden input when Chrome no longer has user activation", async () => {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    const click = vi.spyOn(HTMLInputElement.prototype, "click");

    await expect(pickMarkdownFile()).rejects.toThrow(/direct click/i);
    expect(click).not.toHaveBeenCalled();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });
});
