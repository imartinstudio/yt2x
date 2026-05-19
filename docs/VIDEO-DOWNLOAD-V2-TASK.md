# Video download task

版本归属：v2.0

## 背景

yt2x 当前采集阶段已经能通过 `yt-dlp` / `ffmpeg` 获取视频元数据、字幕、转写分块、时间轴 cues、可选关键帧截图和官方封面。现有链路的默认目标是“把视频内容采集成可生成文档的文本素材”，不会保存视频文件本身。

v2.0 需要在保持现有文本采集稳定的基础上，新增可选视频片段下载能力：

- 用户显式开启后，默认下载视频播放热度最高片段附近的 30 秒。
- 用户也可以手动指定开始时间和结束时间，只下载该时间段。
- 下载结果必须可追踪、可恢复、可审查，不影响现有 `metadata.json` / `chunks.md` / `timestamped-cues.md` 的必需成功条件。

## 目标

新增采集阶段视频片段下载能力：

```text
yt2x acquire / pipeline
  -> metadata.json
  -> optional video/clip.mp4
  -> optional video/clip-manifest.json
  -> subtitles / transcript / screenshots
```

首个可交付版本支持：

- `--download-video`：开启视频片段下载。
- `--video-only`：只下载视频片段，不生成字幕、转写分块、截图和笔记。
- `--video-duration <seconds>`：默认 30 秒。
- `--video-start <time>` + `--video-end <time>`：手动指定下载区间。
- `--video-start <time>` + `--video-duration <seconds>`：从指定开始时间下载 N 秒。
- 自动模式优先使用 YouTube most replayed / heatmap 数据选择最高热度片段。
- heatmap 缺失时有明确降级策略和 warning。

## 非目标

- 不默认下载整段视频。
- 不绕过 YouTube、yt-dlp 或网络环境限制。
- 不提交下载产物、真实视频 ID、真实 YouTube URL、cookies、API key、OAuth token 或浏览器凭证。
- 不改变默认发布行为。
- 不让视频下载失败导致已有文本采集能力整体失败，除非用户后续显式要求严格模式。

## 默认行为决策

v2.0 推荐默认不开启视频下载，原因：

- 避免现有用户无感产生大文件和更长采集时间。
- 避免 CI、批量采集和低带宽环境出现意外成本。
- 保持 `yt2x acquire` 当前语义：默认采集文本和元数据。

开启方式：

```bash
pnpm yt2x acquire --urls "<YOUTUBE_URL>" --download-video
```

如果产品最终决定“默认开启下载视频功能”，需要在 Task 9 中显式改默认值，并同步 README / USAGE / DATA-CONTRACTS 和兼容性说明。

## 用户命令设计

YouTube URL 用引号包住即可，不要在引号内转义 `?` 或 `=`。

默认不开启视频下载：

```bash
pnpm yt2x acquire --urls "<YOUTUBE_URL>"
```

开启后自动下载最高热度区域附近 30 秒：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video
```

手动指定时间段：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --video-start 00:03:10 \
  --video-end 00:03:40
```

pipeline 中使用：

```bash
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --acquire auto --notes auto --article skip --publish skip
```

pipeline 支持 `--download-video`，但不支持 `--video-only`。`pipeline --download-video` 只是 acquire 阶段的附加产物；notes / article 仍依赖字幕转写文件。如果视频没有手动字幕或自动字幕，pipeline 会在 acquire 失败，此时只能先用 `yt2x acquire --video-only` 验证视频片段下载。

只下载视频片段，不做字幕、转写、截图和后续文档生成：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --video-only
```

只下载手动时间段：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --video-only \
  --video-start 00:03:10 \
  --video-end 00:03:40
```

只下载从指定时间开始的 5 秒：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --video-only \
  --video-start 00:07:13 \
  --video-duration 5
```

支持的时间格式：

```text
90
01:30
00:01:30
```

## 产物约定

采集目录：

```text
files/downloads/<videoId>/
  metadata.json
  chunks.md
  timestamped-cues.md
  prepare-result.json
  video/
    clip.mp4
    clip-manifest.json
```

`clip-manifest.json` 自动模式示例：

```json
{
  "version": 1,
  "mode": "hottest",
  "source": "youtube_heatmap",
  "start_seconds": 123.4,
  "end_seconds": 153.4,
  "duration_seconds": 30,
  "file": "video/clip.mp4",
  "format": "mp4",
  "warnings": []
}
```

`clip-manifest.json` 手动模式示例：

```json
{
  "version": 1,
  "mode": "range",
  "source": "user_range",
  "start_seconds": 190,
  "end_seconds": 220,
  "duration_seconds": 30,
  "file": "video/clip.mp4",
  "format": "mp4",
  "warnings": []
}
```

heatmap 缺失降级示例：

```json
{
  "version": 1,
  "mode": "hottest",
  "source": "fallback_no_heatmap",
  "start_seconds": 5,
  "end_seconds": 35,
  "duration_seconds": 30,
  "file": "video/clip.mp4",
  "format": "mp4",
  "warnings": ["metadata heatmap unavailable; used fallback range 00:00:05-00:00:35"]
}
```

## 设计原则

- 视频片段下载属于 acquire 的可选子步骤，不是 notes / article / publish 的职责。
- `clip-manifest.json` 是视频片段的唯一机器可读索引。
- `--video-only` 仍应写入 `metadata.json`、`prepare-result.json`、`video/clip-manifest.json`，便于续跑和审查。
- `prepare-result.json` 记录下载 warning 和耗时，便于排查。
- 手动时间段优先级高于自动 heatmap 选择。
- 自动模式只下载短片段，默认 30 秒。
- 下载失败默认降级为 warning，不破坏文本采集主链路。
- 所有新增 CLI 示例必须使用 `<YOUTUBE_URL>` 和 `<videoId>` 占位符。

## 核心实现设计

新增模块：

```text
packages/adapters-node/src/acquire/video-clip.ts
```

建议职责：

- `parseClipTimestamp(value: string): number`
- `resolveClipRange(input): ClipRange`
- `selectHottestClipRange(metadata, durationSeconds): ClipRange`
- `downloadVideoClip(url, videoDir, options): Promise<VideoClipResult>`
- `writeClipManifest(videoDir, manifest): Promise<void>`

新增类型建议：

```ts
export type VideoClipMode = "hottest" | "range";

export type VideoClipOptions = {
  enabled: boolean;
  durationSeconds: number;
  start?: string;
  end?: string;
};

export type ClipRange = {
  mode: VideoClipMode;
  source: "youtube_heatmap" | "fallback_no_heatmap" | "user_range";
  startSeconds: number;
  endSeconds: number;
};
```

`yt-dlp` 下载命令建议：

```text
yt-dlp
  -f bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4][vcodec^=avc1]
  --merge-output-format mp4
  --download-sections "*<START>-<END>"
  -o "<videoDir>/video/clip.%(ext)s"
  "<YOUTUBE_URL>"
```

视频片段下载只选择 H.264/AVC (`avc1`) MP4，避免 YouTube 返回 AV1-in-MP4 后无法上传到 X。

必须复用现有 `cookiesFromBrowser`、`proxy`、`timeoutMs`、`signal` 和 `ProcessRunner`。

## 参数和数据流

需要扩展的位置：

```text
packages/cli/src/commands/acquire.ts
packages/cli/src/commands/pipeline.ts
packages/cli/src/commands/command-flags.ts
packages/cli/src/args/commander-pipeline-flags.ts
packages/cli/src/args/pipeline.ts
packages/cli/src/orchestrator/native-acquire-from-pipeline-args.ts
packages/adapters-node/src/acquire/execute-native-acquire.ts
packages/adapters-node/src/acquire/prepare-youtube-video.ts
```

参数流：

```text
Commander flags
  -> PipelineArgsSchema.acquire
  -> nativeAcquireOptionsFromPipelineArgs
  -> executeNativeAcquire.acquire
  -> prepareYoutubeVideo.videoClip
  -> downloadVideoClip
```

建议 Zod 字段：

```ts
downloadVideo: z.boolean().default(false),
videoOnly: z.boolean().default(false),
videoStart: z.string().optional(),
videoEnd: z.string().optional(),
videoDuration: z.coerce.number().int().min(1).max(600).default(30),
```

校验规则：

- `videoStart` / `videoEnd` 任一存在时，必须开启 `downloadVideo` 或由解析层自动视为开启。
- `videoOnly === true` 时，必须开启 `downloadVideo` 或由解析层自动视为开启。
- `videoOnly === true` 只适用于 `acquire` 单阶段命令；`pipeline --video-only` 应直接报错并提示使用 `yt2x acquire --video-only`。
- 若同时提供 `videoStart` 和 `videoEnd`，`end > start`。
- 若只提供 `videoStart`，使用 `videoDuration` 计算结束时间。
- 手动时间段不允许超过 `metadata.duration`；如果 metadata 缺失 duration，则允许 yt-dlp 自行处理，但 manifest 记录 warning。
- `videoDuration` 最大先限制为 600 秒，避免误下载大段视频。

## heatmap 选择策略

自动模式：

1. 从完整 metadata 中读取 heatmap / most replayed 数据。
2. 找到热度值最高的 bucket。
3. 使用 bucket 中点作为中心点。
4. 以 `videoDuration / 2` 向前后扩展。
5. 根据 `metadata.duration` 将范围限制在 `[0, duration]`。
6. 如果视频时长小于请求时长，则下载 `[0, duration]`。

heatmap 缺失：

1. 写入 warning。
2. 若有 `metadata.duration` 且 duration 大于 35 秒，使用 `[5, 35]`。
3. 若视频短于 35 秒，使用 `[0, min(duration, videoDuration)]`。
4. 若无 duration，使用 `[5, 35]`，由 yt-dlp / ffmpeg 处理边界。

## 开发步骤

本功能必须按任务拆分推进。每个任务完成后，需要在本节把任务总览和任务内完成标记从 `[ ]` 改为 `[x]`，将状态改为“已执行”，并确保该任务的验收标准已经满足。

任务总览：

- [x] Task 1: CLI option contract
- [x] Task 2: Video clip domain helpers
- [x] Task 3: yt-dlp clip download adapter
- [x] Task 4: prepareYoutubeVideo integration
- [x] Task 5: native acquire and pipeline wiring
- [x] Task 6: progress, result, and artifact validation
- [x] Task 7: tests for helpers and adapter calls
- [x] Task 8: documentation and data contracts
- [x] Task 9: default behavior decision gate
- [x] Task 10: video-only single command mode

### Task 1: CLI option contract

状态：已执行

范围：

- 在 `acquire` 和 `pipeline` 命令中新增 `--download-video`、`--video-start`、`--video-end`、`--video-duration`。
- 在 `acquire` 命令中新增 `--video-only`。
- 扩展 `SingleStageFlags` 和 `CommanderPipelineFlags`。
- 扩展 `AcquireOptionsSchema`，包含默认值和基础校验。
- 明确 `--video-start` / `--video-end` 出现时是否自动开启下载；推荐自动开启并输出 verbose 日志。
- 明确 `pipeline --video-only` 不支持，避免 pipeline 语义和后续阶段冲突。

验收：

- `pnpm yt2x acquire --help` 显示新增参数。
- `pnpm yt2x pipeline --help` 显示新增参数。
- `pnpm yt2x acquire --help` 显示 `--video-only`。
- 参数解析单测覆盖默认值、显式开启、手动时间段、非法时间段和 video-only。

完成后标记：

- [x] Task 1 complete

### Task 2: Video clip domain helpers

状态：已执行

范围：

- 新增 `video-clip.ts`。
- 实现时间字符串解析。
- 实现手动范围解析。
- 实现 heatmap 最高热度范围选择。
- 实现 heatmap 缺失降级策略。
- 生成稳定 `ClipRange` 和 manifest 数据结构。

验收：

- `90`、`01:30`、`00:01:30` 解析正确。
- 非法时间字符串抛出明确错误。
- `end <= start` 抛出明确错误。
- heatmap 最高 bucket 能生成 30 秒窗口。
- 片头、片尾和短视频边界 clamp 正确。
- heatmap 缺失时 manifest warning 可追踪。

完成后标记：

- [x] Task 2 complete

### Task 3: yt-dlp clip download adapter

状态：已执行

范围：

- 在 `video-clip.ts` 或 `yt-dlp.ts` 中封装 `downloadVideoClip`。
- 使用 `--download-sections` 下载指定时间段。
- 默认输出 `video/clip.mp4`。
- 限制格式优先选择 720p 以内 mp4，减少体积和兼容问题。
- 复用已有 `proxy`、`cookiesFromBrowser`、`timeoutMs`、`signal`。
- 下载前清理旧的 `video/clip.*`，并向 `yt-dlp` 传 `--force-overwrites`，避免 manifest 与旧视频文件不一致。
- 下载完成后确认文件存在且非空。

验收：

- mocked runner 能看到 `yt-dlp` 调用包含 `--download-sections`。
- mocked runner 能看到 `--merge-output-format mp4`。
- mocked runner 能看到 `--force-overwrites`。
- cookies / proxy 参数会传入下载命令。
- 已存在旧 `clip.mp4` 时，新下载会覆盖旧文件。
- 下载失败返回 warning，不直接破坏文本采集主链路。

完成后标记：

- [x] Task 3 complete

### Task 4: prepareYoutubeVideo integration

状态：已执行

范围：

- 扩展 `PrepareYoutubeVideoOptions`，新增 `videoClip` 配置。
- 在 metadata 写入后执行可选视频片段下载。
- 将下载耗时写入 `timingsMs.video-clip`。
- 将下载结果写入 `PrepareYoutubeVideoResult`。
- 下载失败时写入 `result.warnings`。

验收：

- 未开启下载时行为与当前完全一致。
- 开启下载时生成 `video/clip.mp4` 和 `video/clip-manifest.json`。
- 下载失败时仍可继续字幕和转写处理。
- `prepare-result.json` 能看到视频下载 warning 和 timings。

完成后标记：

- [x] Task 4 complete

### Task 5: native acquire and pipeline wiring

状态：已执行

范围：

- 扩展 `NativeAcquireOptions.acquire`。
- 在 `nativeAcquireOptionsFromPipelineArgs` 中传递视频下载配置。
- 在 `executeNativeAcquire` 调用 `prepareYoutubeVideo` 时传递视频下载配置。
- 保持 `--continue-from` 的现有跳过逻辑稳定。

验收：

- `yt2x acquire --download-video` 能触发下载。
- `yt2x pipeline --download-video` 能触发下载。
- `yt2x acquire --download-video --video-only` 能只执行 metadata 和 video clip 子步骤。
- `--continue-from` 不会因为已有可选视频片段缺失而错误跳过或错误失败。

完成后标记：

- [x] Task 5 complete

### Task 6: progress, result, and artifact validation

状态：已执行

范围：

- 在 acquire progress 中展示 `video-clip` 子步骤。
- 明确 `doneArtifacts` 是否包含视频片段；推荐不包含，因为它是可选产物。
- 在 `clip-manifest.json` 中记录 warnings、mode、source、start/end、file。
- 如需后续严格模式，预留 `downloadVideoRequired` 设计但不在 v2.0 首版实现。

验收：

- 开启下载时进度输出包含视频片段下载步骤。
- 未开启下载时进度输出不增加噪音。
- `process-status.json` 的 acquire 必需 artifact 仍保持 `metadata.json`、`chunks.md`、`timestamped-cues.md`。

完成后标记：

- [x] Task 6 complete

### Task 7: tests for helpers and adapter calls

状态：已执行

范围：

- 新增 `video-clip.test.ts`。
- 扩展 `prepare-youtube-video.test.ts`。
- 扩展 CLI 参数解析测试。
- 必要时扩展 `execute-native-acquire.test.ts`。

验收：

- 时间解析、范围校验、heatmap 选择、fallback 均有单测。
- mocked `yt-dlp` 下载命令参数被断言。
- `prepareYoutubeVideo` 开启下载时写 manifest。
- 下载失败不导致 `result.ok` 失败的行为被测试覆盖。

完成后标记：

- [x] Task 7 complete

### Task 8: documentation and data contracts

状态：已执行

范围：

- 更新 `README.md` 的常用命令。
- 更新 `docs/USAGE.md` 的 acquire / pipeline 参数说明。
- 更新 `docs/DATA-CONTRACTS.md` 的每视频目录产物表。
- 如 CLI help snapshot 或 README 命令示例发生变化，同步测试。

验收：

- 所有文档示例只使用 `<YOUTUBE_URL>` 和 `<videoId>` 占位符。
- 文档说明默认不下载视频，开启后默认下载最高热度 30 秒。
- 文档说明手动时间段优先于自动 heatmap。
- 文档说明下载失败默认不影响文本采集。

完成后标记：

- [x] Task 8 complete

### Task 9: default behavior decision gate

状态：已执行

结论：默认保持不下载视频。用户必须通过 `--download-video` 或 `--video-only` 显式开启，避免现有 acquire / pipeline 在批量场景中突然产生视频文件、增加耗时和占用磁盘。

范围：

- 在代码实现完成后，基于真实手测结果决定是否保持“默认不开启”。
- 如果要改为默认开启，需要将 `downloadVideo` 默认值改为 `true`。
- 同步更新 README、USAGE、DATA-CONTRACTS、测试和迁移说明。
- 明确如何避免批量采集意外下载大量视频片段。

验收：

- 默认行为有明确产品结论。
- 若默认开启，必须提供显式关闭参数，例如 `--no-download-video`。
- 若默认不开启，当前 v2.0 文档保持不变。

完成后标记：

- [x] Task 9 complete

### Task 10: video-only single command mode

状态：已执行

范围：

- 在 acquire 单阶段中支持 `--video-only`。
- `--video-only` 自动启用视频下载，不要求用户重复传 `--download-video`；但文档示例保留 `--download-video` 以表达意图。
- `--video-only` 仍先获取 metadata，因为自动热度选择和输出目录命名依赖 metadata。
- `--video-only` 跳过 subtitles、transcript、scene-keyframes 和 thumbnail。
- `--video-only` 的成功标准改为 `metadata.json`、`video/clip-manifest.json` 和实际视频片段文件存在。
- `--video-only` 不应把 `chunks.md` / `timestamped-cues.md` 作为必需 artifacts。
- `pipeline --video-only` 明确报错，提示使用 `yt2x acquire --video-only`。

验收：

- `pnpm yt2x acquire --urls "<YOUTUBE_URL>" --video-only` 可以只下载默认最高热度 30 秒片段。
- `pnpm yt2x acquire --urls "<YOUTUBE_URL>" --video-only --video-start 00:01:00 --video-end 00:01:30` 可以只下载手动时间段。
- video-only 模式不会生成 `chunks.md` 和 `timestamped-cues.md`。
- video-only 模式的 `process-status.json` acquire step 不要求字幕相关 artifacts。
- video-only 模式下载失败时退出码为 1，因为该模式的主目标就是下载视频。
- 相关行为有单测或 mocked integration 覆盖。

完成后标记：

- [x] Task 10 complete

## 执行纪律

- 每完成一个 Task，必须在本文档中同时更新：
  - 任务总览 `[ ]` -> `[x]`
  - 该 Task 的 `状态：未开始` -> `状态：已执行`
  - 该 Task 的 `Task N complete` -> `[x]`
- 每次代码改动后至少运行与改动相关的测试。
- 涉及用户可见 CLI 行为时，必须同步文档。
- 不提交 `files/downloads/` 下的视频片段产物。
- 不在测试或文档中使用真实 YouTube URL / videoId。

## 推荐执行命令

开发期快速验证：

```bash
pnpm test -- video-clip
pnpm test -- prepare-youtube-video
pnpm test -- commander-pipeline-flags
```

阶段性质量闸：

```bash
pnpm run build
pnpm test
```

真实手测命令：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --out-dir ./files/downloads

pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --video-only \
  --out-dir ./files/downloads

pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --video-start 00:01:00 \
  --video-end 00:01:30 \
  --out-dir ./files/downloads

pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --video-only \
  --video-start 00:07:13 \
  --video-duration 5 \
  --out-dir ./files/downloads
```
