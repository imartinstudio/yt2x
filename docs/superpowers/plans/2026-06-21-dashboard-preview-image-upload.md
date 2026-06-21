# Dashboard Preview Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Dashboard 平台预览中的图片 Prompt 卡片提供本地图片上传、替换和删除能力。

**Architecture:** 预览 HTML 为每个 Prompt 卡片渲染上传控件。客户端把单张图片编码为 data URL，提交到 Dashboard 路由；服务端校验并存入平台图片目录，同时更新 `prompts.json` 和对应 Markdown 图片引用。预览成功后刷新，以服务端状态为准。

**Tech Stack:** TypeScript、Node.js `http`、`node:fs/promises`、Vitest。

---

### Task 1: 添加上传校验与持久化服务

**Files:**

- Modify: `packages/cli/src/commands/dashboard.ts`
- Test: `packages/cli/src/commands/dashboard.test.ts`

- [x] **Step 1: 写入失败测试**

为 `decodeDashboardImage` 编写测试：合法 PNG data URL 返回 Buffer 与 `.png`；GIF 被拒绝；解码后超过 10MB 被拒绝。为 `saveDashboardPromptImage` 编写临时目录测试：它写入 `<platform>-format/images/prompt-ill-0.png`，更新 `prompts.json` 的 filename，并在平台 Markdown 中写入图片引用。

```ts
expect(decodeDashboardImage("data:image/png;base64,AA==")).toEqual({
  data: Buffer.from([0]),
  extension: ".png",
});
expect(() => decodeDashboardImage("data:image/gif;base64,AA==")).toThrow(
  "仅支持 JPG、PNG、WebP 图片",
);
expect(await saveDashboardPromptImage(input)).toMatchObject({ file: "prompt-ill-0.png" });
```

- [x] **Step 2: 运行失败测试**

Run: `pnpm test packages/cli/src/commands/dashboard.test.ts`

Expected: FAIL，因为两个 helper 尚不存在。

- [x] **Step 3: 实现最小服务端逻辑**

实现 data URL MIME 白名单（JPEG、PNG、WebP）与 10MB 解码后大小检查。实现 `saveDashboardPromptImage` 与 `deleteDashboardPromptImage`：校验 video ID、平台、`cover` / `ill-<index>` Prompt ID，所有路径必须位于视频文章目录内；生成确定性文件名；更新 Prompt 元数据与 Markdown；旧图仅在无剩余引用时删除。新增 `POST /api/prompts/image` 与 `POST /api/prompts/image/delete`，使用既有 JSON body 读取器并返回 `{ ok: true, file }` 或明确的 400 错误。

```ts
const destination = path.join(
  articleDir,
  formatDir,
  "images",
  `prompt-${promptId}${image.extension}`,
);
if (!path.resolve(destination).startsWith(path.resolve(articleDir) + path.sep))
  throw new Error("无效图片路径");
await writeFile(destination, image.data);
```

- [x] **Step 4: 运行通过测试**

Run: `pnpm test packages/cli/src/commands/dashboard.test.ts`

Expected: PASS。

### Task 2: 在预览 Prompt 卡片实现上传交互

**Files:**

- Modify: `packages/adapters-node/src/platform-format/prompt-orchestrator.ts`
- Test: `packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts`

- [x] **Step 1: 写入失败测试**

扩展含 `prompts.json` 的预览测试，断言生成 HTML 含 `ph-upload-btn`、`data-prompt-id="ill-0"` 和仅接受 JPEG、PNG、WebP 的隐藏 file input。

```ts
expect(result!.html).toContain('class="ph-upload-btn"');
expect(result!.html).toContain('data-prompt-id="ill-0"');
expect(result!.html).toContain('accept="image/jpeg,image/png,image/webp"');
```

- [x] **Step 2: 运行失败测试**

Run: `pnpm test packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts`

Expected: FAIL，因为卡片尚无上传控件。

- [x] **Step 3: 实现最小预览交互**

在 `promptActions` 增加“上传图片”按钮与隐藏单文件 input。预览脚本为按钮、拖放区和粘贴事件注册处理器；客户端先校验格式和 10MB，再用 `FileReader.readAsDataURL` 提交 `{ videoId, platform, promptId, dataUrl }`。成功时刷新预览，失败时使用现有 toast。实际图片旁显示“替换图片”和“删除图片”；删除调用新删除接口，成功才刷新。

```ts
const resp = await fetch("/api/prompts/image", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ videoId, platform, promptId, dataUrl }),
});
if (!resp.ok) throw new Error((await resp.json()).error);
location.reload();
```

- [x] **Step 4: 运行通过测试**

Run: `pnpm test packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts`

Expected: PASS。

### Task 3: 完整验证与提交

**Files:**

- Modify: `docs/superpowers/plans/2026-06-21-dashboard-preview-image-upload.md`

- [x] **Step 1: 运行定向测试**

Run: `pnpm test packages/cli/src/commands/dashboard.test.ts packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts`

Expected: PASS。

- [x] **Step 2: 运行类型检查**

Run: `pnpm run typecheck`

Expected: PASS。

- [x] **Step 3: 检查最终变更**

Run: `git diff --check` 与 `git diff --stat`

Expected: 无空白错误；仅涉及 Dashboard、预览渲染器、相应测试与本计划。

- [ ] **Step 4: 提交实现**

暂存上述生产代码、测试与计划文件，并以包含 summary、body 和 Included 列表的提交信息提交。
