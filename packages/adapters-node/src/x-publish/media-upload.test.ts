import { describe, expect, it, vi } from "vitest";
import { XPublishError } from "@yt2x/core";
import { uploadTweetImageWithAuthedJson } from "./media-upload.js";

const okMedia = (id: string, processing?: { state: string; check_after_secs?: number }): unknown => ({
  data: {
    id,
    ...(processing !== undefined ? { processing_info: processing } : {}),
  },
  meta: {},
});

const expectImageForm = async (
  form: FormData | undefined,
  expected: { mediaType: string; mediaCategory: string },
): Promise<void> => {
  expect(form).toBeInstanceOf(FormData);
  expect(form?.get("media_type")).toBe(expected.mediaType);
  expect(form?.get("media_category")).toBe(expected.mediaCategory);
  const media = form?.get("media");
  expect(media).toBeInstanceOf(Blob);
  expect((media as Blob).type).toBe(expected.mediaType);
  expect((await (media as Blob).arrayBuffer()).byteLength).toBeGreaterThan(0);
};

describe("uploadTweetImageWithAuthedJson", () => {
  it("rejects empty bytes before any HTTP call", async () => {
    const authedJson = vi.fn();
    await expect(
      uploadTweetImageWithAuthedJson({
        bytes: new Uint8Array(0),
        contentType: "image/png",
        authedJson,
      }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    expect(authedJson).not.toHaveBeenCalled();
  });

  it("uses one-shot POST /2/media/upload for small files without STATUS when no processing is reported", async () => {
    const body = Buffer.alloc(100, 7);
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        await expectImageForm(req.formData, {
          mediaType: "image/png",
          mediaCategory: "tweet_image",
        });
        return okMedia("999000111222333444");
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const id = await uploadTweetImageWithAuthedJson({
      bytes: body,
      contentType: "image/png",
      authedJson,
    });
    expect(id).toBe("999000111222333444");
    expect(authedJson).toHaveBeenCalledTimes(1);
  });

  it("polls STATUS until succeeded when processing_info is pending", async () => {
    const body = Buffer.alloc(50, 1);
    let statusCalls = 0;
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        return okMedia("111", { state: "pending", check_after_secs: 0 });
      }
      if (req.method === "GET") {
        statusCalls += 1;
        if (statusCalls < 3) return okMedia("111", { state: "in_progress", check_after_secs: 0 });
        return okMedia("111", { state: "succeeded" });
      }
      throw new Error("unexpected");
    });
    const id = await uploadTweetImageWithAuthedJson({
      bytes: body,
      contentType: "image/webp",
      authedJson,
    });
    expect(id).toBe("111");
    expect(statusCalls).toBe(3);
  });

  it("throws MEDIA_PROCESSING when STATUS reports failed", async () => {
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST") return okMedia("222", { state: "pending" });
      return okMedia("222", { state: "failed" });
    });
    await expect(
      uploadTweetImageWithAuthedJson({
        bytes: Buffer.alloc(20),
        contentType: "image/jpeg",
        authedJson,
      }),
    ).rejects.toMatchObject({ kind: "MEDIA_PROCESSING" });
  });

  it("falls back to chunked when one-shot returns BAD_REQUEST", async () => {
    const big = Buffer.alloc(100, 9);
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        throw new XPublishError("BAD_REQUEST", "one-shot rejected", { status: 400 });
      }
      if (req.method === "POST" && req.path === "/2/media/upload/initialize") {
        return okMedia("333");
      }
      if (req.method === "POST" && req.path.includes("/append")) {
        return { data: {}, meta: {} };
      }
      if (req.method === "POST" && req.path.includes("/finalize")) {
        return okMedia("333");
      }
      if (req.method === "GET") return okMedia("333");
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const id = await uploadTweetImageWithAuthedJson({
      bytes: big,
      contentType: "image/jpeg",
      authedJson,
    });
    expect(id).toBe("333");
    expect(authedJson.mock.calls.some((c) => c[0]?.path === "/2/media/upload/initialize")).toBe(true);
  });

  it("includes both one-shot and chunked failures when v2 media upload is unavailable", async () => {
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        throw new XPublishError("BAD_REQUEST", "one-shot not found", {
          status: 400,
          url: "https://api.x.com/2/media/upload",
          detail: "BadRequest: Not found",
        });
      }
      if (req.method === "POST" && req.path === "/2/media/upload/initialize") {
        throw new XPublishError("BAD_REQUEST", "chunked init not found", {
          status: 400,
          url: "https://api.x.com/2/media/upload/initialize",
          detail: "BadRequest: Not found",
        });
      }
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });

    await expect(
      uploadTweetImageWithAuthedJson({
        bytes: Buffer.alloc(100, 9),
        contentType: "image/png",
        authedJson,
      }),
    ).rejects.toThrow(/one-shot=.*chunked=/);
  });

  it("uses tweet_gif category for image/gif", async () => {
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        await expectImageForm(req.formData, {
          mediaType: "image/gif",
          mediaCategory: "tweet_gif",
        });
        return okMedia("444");
      }
      if (req.method === "GET") return okMedia("444");
      throw new Error("unexpected");
    });
    await uploadTweetImageWithAuthedJson({
      bytes: Buffer.alloc(30),
      contentType: "image/gif",
      authedJson,
    });
    expect(authedJson).toHaveBeenCalled();
  });

  it("uses one-shot for images up to 5 MiB", async () => {
    const size = 600 * 1024;
    const authedJson = vi.fn(async (req) => {
      if (req.path === "/2/media/upload") {
        await expectImageForm(req.formData, {
          mediaType: "image/png",
          mediaCategory: "tweet_image",
        });
        return okMedia("555");
      }
      if (req.method === "GET") return okMedia("555");
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const id = await uploadTweetImageWithAuthedJson({
      bytes: Buffer.alloc(size, 3),
      contentType: "image/png",
      authedJson,
    });
    expect(id).toBe("555");
    expect(authedJson.mock.calls.some((c) => c[0]?.path === "/2/media/upload")).toBe(true);
  });

  it("does not fall back to chunked on AUTH from one-shot", async () => {
    const authedJson = vi.fn(async () => {
      throw new XPublishError("AUTH", "nope", { status: 401 });
    });
    await expect(
      uploadTweetImageWithAuthedJson({
        bytes: Buffer.alloc(20),
        contentType: "image/png",
        authedJson,
      }),
    ).rejects.toMatchObject({ kind: "AUTH" });
    expect(authedJson).toHaveBeenCalledTimes(1);
  });
});
