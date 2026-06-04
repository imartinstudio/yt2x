import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTableMarkdownToPngBlob } from "./table-image.js";

describe("renderTableMarkdownToPngBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws markdown tables directly to canvas without loading an intermediate image", async () => {
    let imageCreated = false;
    vi.stubGlobal(
      "Image",
      class {
        constructor() {
          imageCreated = true;
        }
      },
    );

    const context = {
      set font(_value: string) {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set textBaseline(_value: string) {},
      set lineWidth(_value: number) {},
      measureText: (text: string) => ({ width: text.length * 12 }),
      scale: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(function (
        callback: BlobCallback,
        _type?: string,
        _quality?: unknown,
      ): void {
        callback(new Blob(["png"], { type: "image/png" }));
      });

    const blob = await renderTableMarkdownToPngBlob(
      [
        "| 维度 | 检查项 | 标准 |",
        "|------|--------|------|",
        "| 字体 | 是否避免了 AI 常用字体？ | 替换 Inter、Roboto 等 |",
      ].join("\n"),
    );

    expect(blob.type).toBe("image/png");
    expect(getContext).toHaveBeenCalledWith("2d");
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(context.fillText).toHaveBeenCalled();
    expect(imageCreated).toBe(false);
  });
});
