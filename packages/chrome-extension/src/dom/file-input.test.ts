import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSIGN_FILE_MAIN_WORLD_MESSAGE,
  TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE,
  normalizeUploadFile,
  requestMainWorldFileAssignment,
  triggerFileUploadMainWorld,
  uploadFileThroughAction,
} from "./file-input.js";

describe("file-input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("fills missing video mime types", () => {
    const file = normalizeUploadFile(new File(["mp4"], "clip.mp4"));
    expect(file.type).toBe("video/mp4");
  });

  it("requests page-context file assignment through the extension worker", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await requestMainWorldFileAssignment(
      'input[data-yt2x-upload-target="upload"]',
      "blob:https://x.com/upload",
      "cover.png",
      "image/png",
    );

    expect(sendMessage).toHaveBeenCalledWith({
      type: ASSIGN_FILE_MAIN_WORLD_MESSAGE,
      selector: 'input[data-yt2x-upload-target="upload"]',
      blobUrl: "blob:https://x.com/upload",
      name: "cover.png",
      mimeType: "image/png",
    });
  });

  it("surfaces worker file assignment failures", async () => {
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false, error: "No current tab" }) },
    });

    await expect(
      requestMainWorldFileAssignment("input", "blob:https://x.com/upload", "cover.png", "image/png"),
    ).rejects.toThrow("No current tab");
  });

  it("requests a MAIN-world upload-action trigger for files without persistent inputs", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, intercepted: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.stubGlobal(
      "URL",
      Object.assign(class extends URL {}, {
        createObjectURL: vi.fn(() => "blob:https://x.com/video"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const action = document.createElement("div");
    action.setAttribute("role", "menuitem");

    await expect(uploadFileThroughAction(action, new File(["mp4"], "clip.mp4"))).resolves.toBe(
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TRIGGER_FILE_UPLOAD_MAIN_WORLD_MESSAGE,
        blobUrl: "blob:https://x.com/video",
        name: "clip.mp4",
        mimeType: "video/mp4",
      }),
    );
    expect(action.hasAttribute("data-yt2x-upload-action")).toBe(false);
  });

  it("intercepts a temporary page-owned file input opened by the media button", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue(new Blob(["mp4"])) }));
    vi.stubGlobal(
      "DataTransfer",
      class {
        files: File[] = [];
        items = {
          add: (file: File): void => {
            this.files.push(file);
          },
        };
      },
    );
    const button = document.createElement("button");
    button.id = "upload-video";
    const input = document.createElement("input");
    input.type = "file";
    let uploadedName = "";
    input.addEventListener("change", () => {
      uploadedName = input.files?.[0]?.name ?? "";
    });
    button.addEventListener("click", () => {
      input.click();
    });
    document.body.appendChild(button);

    const filesDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get() {
        return (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles ?? [];
      },
      set(files: File[]) {
        (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles = files;
      },
    });
    try {
      await expect(
        triggerFileUploadMainWorld("#upload-video", "blob:https://x.com/video", "clip.mp4", "video/mp4"),
      ).resolves.toBe(true);
      expect(uploadedName).toBe("clip.mp4");
    } finally {
      if (filesDescriptor !== undefined) {
        Object.defineProperty(HTMLInputElement.prototype, "files", filesDescriptor);
      }
    }
  });

  it("intercepts a temporary page-owned file input opened with showPicker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue(new Blob(["mp4"])) }));
    vi.stubGlobal(
      "DataTransfer",
      class {
        files: File[] = [];
        items = {
          add: (file: File): void => {
            this.files.push(file);
          },
        };
      },
    );
    const action = document.createElement("div");
    action.id = "video-menu-item";
    const input = document.createElement("input");
    input.type = "file";
    let uploadedName = "";
    input.addEventListener("change", () => {
      uploadedName = input.files?.[0]?.name ?? "";
    });
    action.addEventListener("click", () => {
      input.showPicker();
    });
    document.body.appendChild(action);

    const filesDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    const showPickerDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "showPicker");
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get() {
        return (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles ?? [];
      },
      set(files: File[]) {
        (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles = files;
      },
    });
    Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
      configurable: true,
      value() {},
      writable: true,
    });
    try {
      await expect(
        triggerFileUploadMainWorld(
          "#video-menu-item",
          "blob:https://x.com/video",
          "clip.mp4",
          "video/mp4",
        ),
      ).resolves.toBe(true);
      expect(uploadedName).toBe("clip.mp4");
    } finally {
      if (filesDescriptor !== undefined) {
        Object.defineProperty(HTMLInputElement.prototype, "files", filesDescriptor);
      }
      if (showPickerDescriptor === undefined) {
        delete (HTMLInputElement.prototype as Partial<HTMLInputElement>).showPicker;
      } else {
        Object.defineProperty(HTMLInputElement.prototype, "showPicker", showPickerDescriptor);
      }
    }
  });

  it("keeps intercepting while a media menu creates its file input asynchronously", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue(new Blob(["media"])) }));
    vi.stubGlobal(
      "DataTransfer",
      class {
        files: File[] = [];
        items = {
          add: (file: File): void => {
            this.files.push(file);
          },
        };
      },
    );
    const action = document.createElement("button");
    action.id = "async-media-menu-item";
    const input = document.createElement("input");
    input.type = "file";
    let uploadedName = "";
    input.addEventListener("change", () => {
      uploadedName = input.files?.[0]?.name ?? "";
    });
    action.addEventListener("click", () => {
      window.setTimeout(() => input.click(), 150);
    });
    document.body.appendChild(action);

    const filesDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get() {
        return (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles ?? [];
      },
      set(files: File[]) {
        (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles = files;
      },
    });
    try {
      await expect(
        triggerFileUploadMainWorld(
          "#async-media-menu-item",
          "blob:https://x.com/media",
          "scene.jpg",
          "image/jpeg",
        ),
      ).resolves.toBe(true);
      expect(uploadedName).toBe("scene.jpg");
    } finally {
      if (filesDescriptor !== undefined) {
        Object.defineProperty(HTMLInputElement.prototype, "files", filesDescriptor);
      }
    }
  });

  it("intercepts a file input activated through a media label", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue(new Blob(["media"])) }));
    vi.stubGlobal(
      "DataTransfer",
      class {
        files: File[] = [];
        items = {
          add: (file: File): void => {
            this.files.push(file);
          },
        };
      },
    );
    const action = document.createElement("label");
    action.id = "label-media-action";
    action.htmlFor = "body-media-input";
    const input = document.createElement("input");
    input.id = "body-media-input";
    input.type = "file";
    let uploadedName = "";
    input.addEventListener("change", () => {
      uploadedName = input.files?.[0]?.name ?? "";
    });
    document.body.append(action, input);

    const filesDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get() {
        return (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles ?? [];
      },
      set(files: File[]) {
        (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles = files;
      },
    });
    try {
      await expect(
        triggerFileUploadMainWorld(
          "#label-media-action",
          "blob:https://x.com/media",
          "scene.jpg",
          "image/jpeg",
        ),
      ).resolves.toBe(true);
      expect(uploadedName).toBe("scene.jpg");
    } finally {
      if (filesDescriptor !== undefined) {
        Object.defineProperty(HTMLInputElement.prototype, "files", filesDescriptor);
      }
    }
  });

  it("reacquires a rendered media menu action when its tagged node was replaced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: vi.fn().mockResolvedValue(new Blob(["media"])) }));
    vi.stubGlobal(
      "DataTransfer",
      class {
        files: File[] = [];
        items = {
          add: (file: File): void => {
            this.files.push(file);
          },
        };
      },
    );
    const action = document.createElement("button");
    action.setAttribute("role", "menuitem");
    action.textContent = "媒体";
    const input = document.createElement("input");
    input.type = "file";
    action.addEventListener("click", () => {
      input.click();
    });
    document.body.appendChild(action);

    const filesDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get() {
        return (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles ?? [];
      },
      set(files: File[]) {
        (this as HTMLInputElement & { uploadedFiles?: File[] }).uploadedFiles = files;
      },
    });
    try {
      await expect(
        triggerFileUploadMainWorld(
          "[data-yt2x-upload-action='removed']",
          "blob:https://x.com/media",
          "clip.mp4",
          "video/mp4",
        ),
      ).resolves.toBe(true);
      expect(input.files?.[0]?.name).toBe("clip.mp4");
    } finally {
      if (filesDescriptor !== undefined) {
        Object.defineProperty(HTMLInputElement.prototype, "files", filesDescriptor);
      }
    }
  });
});
