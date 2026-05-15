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

  it("uses one-shot POST /2/media/upload for small files", async () => {
    const body = Buffer.alloc(100, 7);
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        expect((req.body as { media_category: string }).media_category).toBe("tweet_image");
        expect((req.body as { media_type: string }).media_type).toBe("image/png");
        expect(typeof (req.body as { media: string }).media).toBe("string");
        return okMedia("999000111222333444");
      }
      if (req.method === "GET" && req.path.includes("/2/media/upload?")) {
        expect(req.path).toContain("media_id=999000111222333444");
        expect(req.path).toContain("command=STATUS");
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
    expect(authedJson).toHaveBeenCalledTimes(2);
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

  it("uses tweet_gif category for image/gif", async () => {
    const authedJson = vi.fn(async (req) => {
      if (req.method === "POST" && req.path === "/2/media/upload") {
        expect((req.body as { media_category: string }).media_category).toBe("tweet_gif");
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

  it("skips one-shot for files larger than 512 KiB (chunked only)", async () => {
    const size = 600 * 1024;
    const authedJson = vi.fn(async (req) => {
      if (req.path === "/2/media/upload/initialize") return okMedia("555");
      if (req.path.includes("/append")) return { data: {}, meta: {} };
      if (req.path.includes("/finalize")) return okMedia("555");
      if (req.method === "GET") return okMedia("555");
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const id = await uploadTweetImageWithAuthedJson({
      bytes: Buffer.alloc(size, 3),
      contentType: "image/png",
      authedJson,
    });
    expect(id).toBe("555");
    expect(authedJson.mock.calls.every((c) => c[0]?.path !== "/2/media/upload")).toBe(true);
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
