import { afterEach, describe, expect, it, vi } from "vitest";

const fileInputMocks = vi.hoisted(() => ({
  assignFileToInput: vi.fn(),
  uploadFileThroughAction: vi.fn(),
}));

vi.mock("./file-input.js", () => ({
  assignFileToInput: fileInputMocks.assignFileToInput,
  normalizeUploadFile: (file: File): File => file,
  uploadFileThroughAction: fileInputMocks.uploadFileThroughAction,
}));

import { uploadFileThroughSurface } from "./x-insert-actions.js";

describe("content media upload surface", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uploads through a dialog action when X creates its file input lazily", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const action = document.createElement("div");
    action.setAttribute("role", "button");
    action.setAttribute("aria-label", "选择图片或视频");
    dialog.appendChild(action);
    document.body.appendChild(dialog);
    const file = new File(["image"], "scene.png", { type: "image/png" });
    fileInputMocks.uploadFileThroughAction.mockResolvedValue(true);

    await expect(uploadFileThroughSurface(dialog, file)).resolves.toBeUndefined();

    expect(fileInputMocks.uploadFileThroughAction).toHaveBeenCalledWith(action, file);
    expect(fileInputMocks.assignFileToInput).not.toHaveBeenCalled();
  });

  it("tries an unlabelled upload surface used by a media dialog", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const close = document.createElement("button");
    close.setAttribute("aria-label", "关闭");
    const surface = document.createElement("div");
    surface.setAttribute("role", "button");
    dialog.append(close, surface);
    document.body.appendChild(dialog);
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    fileInputMocks.uploadFileThroughAction.mockImplementation(async (action: HTMLElement) => action === surface);

    await expect(uploadFileThroughSurface(dialog, file)).resolves.toBeUndefined();

    expect(fileInputMocks.uploadFileThroughAction).toHaveBeenCalledWith(surface, file);
    expect(fileInputMocks.uploadFileThroughAction).not.toHaveBeenCalledWith(close, file);
  });

  it("selects a portal body-media input instead of a cover image input", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const coverInput = document.createElement("input");
    coverInput.type = "file";
    coverInput.accept = "image/jpeg,image/png,image/webp";
    const contentInput = document.createElement("input");
    contentInput.type = "file";
    contentInput.accept = "image/jpeg,image/png,image/gif,video/mp4";
    document.body.append(dialog, coverInput, contentInput);
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    fileInputMocks.assignFileToInput.mockImplementation(async () => {
      dialog.appendChild(document.createElement("video"));
    });

    await expect(uploadFileThroughSurface(dialog, file)).resolves.toBeUndefined();

    expect(fileInputMocks.assignFileToInput).toHaveBeenCalledWith(contentInput, file);
    expect(fileInputMocks.assignFileToInput).not.toHaveBeenCalledWith(coverInput, file);
  });

  it("does not treat an early cover input as the delayed content-media input", async () => {
    vi.useFakeTimers();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const coverInput = document.createElement("input");
    coverInput.type = "file";
    coverInput.accept = "image/jpeg,image/png,image/webp";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(editor, dialog, coverInput);
    const file = new File(["image"], "scene.png", { type: "image/png" });
    fileInputMocks.uploadFileThroughAction.mockResolvedValue(false);
    fileInputMocks.assignFileToInput.mockImplementation(async () => {
      dialog.appendChild(document.createElement("img"));
    });

    const uploading = uploadFileThroughSurface(dialog, file);
    await vi.advanceTimersByTimeAsync(300);
    expect(fileInputMocks.assignFileToInput).not.toHaveBeenCalled();

    const contentInput = document.createElement("input");
    contentInput.type = "file";
    contentInput.accept = "image/jpeg,video/mp4";
    document.body.appendChild(contentInput);
    await vi.runAllTimersAsync();
    await expect(uploading).resolves.toBeUndefined();

    expect(fileInputMocks.assignFileToInput).toHaveBeenCalledWith(contentInput, file);
    vi.useRealTimers();
  });
});
