# X video subtitle task

版本归属：**v0.2**

## 背景

yt2x 已在 acquire 阶段支持默认下载完整视频，并将视频约束为适合 X 的 MP4 / 720p 产物。下一步需要补齐“上传到 X 前的视频中文字幕资产”：

```text
video/full.mp4
  -> 英文字幕来源（YouTube 字幕或本地识别）
  -> 中文 SRT 字幕
  -> X 上传资产（首选 full.mp4 + full.zh.srt）
  -> 可选硬字幕兜底 full.zh-burned.mp4
```

推荐方案是 **默认生成独立 `.srt` 中文字幕文件，必要时额外生成硬字幕视频**。SRT 保留 X 原生字幕能力，字幕可开关、画质损失小、后续可复用；硬字幕只作为 X 字幕显示不稳定、移动端默认可见或人工上传兜底方案。

## 目标

新增 X 视频中文字幕准备链路：

```text
files/downloads/<videoId>/video/full.mp4
  -> video/full.en.srt
  -> video/full.zh.srt
  -> 可选 video/full.zh-burned.mp4
  -> files/articles/<videoId>/video/ 同步可发布资产
  -> publish-preview.json 展示视频与字幕资产
```

首个可交付版本（MVP）：

- 默认生成 `video/full.zh.srt`，不默认硬烧录。
- 支持从 YouTube 英文字幕 / 自动英文字幕转换为 SRT。
- 支持没有英文字幕时用本地识别工具生成英文 SRT 的扩展点。
- 支持把中文字幕硬烧录为 `video/full.zh-burned.mp4` 的显式模式。
- 发布预览中展示视频文件、中文字幕文件、是否存在硬字幕兜底文件。

## 非目标

- 不在 v0.2 自动点击 X 正式发布视频。
- 不提交真实 YouTube URL、真实 videoId、cookies、OAuth token、浏览器凭证或下载产物。
- 不默认依赖云端翻译服务；如接入 LLM 翻译，必须走项目已有 LLM 配置。
- 不在 CI 下载真实视频或调用真实 X 上传接口。
- 不要求首版实现多语言字幕管理；v0.2 只做英文来源到中文 SRT。

## 设计原则

- **SRT 优先**：默认产物是 `full.zh.srt`，保持字幕可开关。
- **硬字幕显式 opt-in**：只有传入明确参数时才生成 `full.zh-burned.mp4`。
- **时间轴不变**：翻译字幕时只修改文本，不改 SRT 序号和时间轴。
- **本地可复现**：所有媒体处理通过本地 `yt-dlp` / `ffmpeg` / 可配置识别器完成。
- **发布安全**：publish review 只展示资产与检查结果，不自动发视频。
- **失败可诊断**：每个阶段输出明确 warning / error，写入 `prepare-result.json` 或 `publish-preview.json`。

## 已确认决策

以下决策用于 v0.2 首版实现，除非后续任务明确变更：

| 编号 | 决策点             | v0.2 默认选择                                                          |
| ---- | ------------------ | ---------------------------------------------------------------------- |
| 1    | 字幕功能默认模式   | 默认关闭，用户显式传 `--subtitle-zh srt`                               |
| 2    | 硬字幕支持         | 支持，但作为显式 opt-in                                                |
| 3    | 目标语言标识       | `zh-CN`                                                                |
| 4    | 英文字幕来源优先级 | YouTube 手动字幕 → YouTube 自动字幕 → 本地识别                         |
| 5    | 无英文字幕行为     | 写 warning，不阻断普通 acquire                                         |
| 6    | 本地识别接入       | 通过外部命令配置，例如 `YT2X_TRANSCRIBE_COMMAND`                       |
| 7    | 翻译方式           | 复用项目已有 LLM provider 配置                                         |
| 8    | 翻译失败处理       | 重试一次，仍失败则按模式报错或 warning                                 |
| 9    | 字幕块结构         | 不允许合并或重排，必须保持字幕块数量一致                               |
| 10   | 用户提供字幕       | 支持 `--subtitle-file <path>`                                          |
| 11   | 中文字幕命名       | 固定为 `full.zh.srt`，便于后续发布链路消费                             |
| 12   | manifest           | 生成 `subtitle-manifest.json`，记录来源、翻译方式和 warning            |
| 13   | article 目录同步   | 复制字幕文件到 `files/articles/<videoId>/video/`                       |
| 14   | X 上传推荐         | preview 推荐 `full.mp4 + full.zh.srt`                                  |
| 15   | article 正文       | 不写字幕说明，字幕只进入 manifest / preview                            |
| 16   | 硬字幕样式         | 移动端可读：白字黑描边、底部居中                                       |
| 17   | 硬字幕编码         | MP4 + H.264 + AAC + yuv420p + 720p 上限                                |
| 18   | CI 中 ffmpeg       | 不调用真实 ffmpeg，单测 mock runner 断言参数                           |
| 19   | X 上传字幕自动化   | v0.2 不实现真实 X API 上传字幕，只生成可上传资产和 preview             |
| 20   | 文档位置           | 保留为 `docs/X-VIDEO-SUBTITLE-TASK.md`，根据确认决策维护后续 checklist |

## 产物契约

采集目录：

```text
files/downloads/<videoId>/video/
  full.mp4
  full.en.srt
  full.zh.srt
  full.zh-burned.mp4       # 可选
  subtitle-manifest.json
```

文章 / 发布目录：

```text
files/articles/<videoId>/video/
  full.mp4
  full.zh.srt
  full.zh-burned.mp4       # 可选
```

`subtitle-manifest.json`：

```json
{
  "version": 1,
  "source_video": "video/full.mp4",
  "source_language": "en",
  "target_language": "zh-CN",
  "source_subtitle": "video/full.en.srt",
  "target_subtitle": "video/full.zh.srt",
  "burned_video": "video/full.zh-burned.mp4",
  "source_method": "youtube_subtitles",
  "translation_method": "llm",
  "warnings": []
}
```

字段约定：

| 字段                 | 说明                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `source_video`       | 源视频，相对视频目录所在视频根目录，例如 `video/full.mp4`              |
| `source_language`    | 源字幕语言，v0.2 默认 `en`                                             |
| `target_language`    | 目标字幕语言，v0.2 默认 `zh-CN`                                        |
| `source_subtitle`    | 英文 SRT 文件；没有英文字幕且识别失败时不存在                          |
| `target_subtitle`    | 中文 SRT 文件；默认目标产物                                            |
| `burned_video`       | 可选硬字幕视频；未生成时省略                                           |
| `source_method`      | `youtube_subtitles` / `youtube_auto_subtitles` / `local_transcription` |
| `translation_method` | `llm` / `manual` / `external_command`                                  |
| `warnings`           | 非阻断问题，例如字幕缺段、翻译回合失败后重试                           |

## CLI 设计

建议新增 acquire 参数：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --subtitle-zh srt
```

参数：

| 参数                         | 默认值  | 说明                                               |
| ---------------------------- | ------- | -------------------------------------------------- |
| `--subtitle-zh <mode>`       | `off`   | `off` / `srt` / `burned` / `both`                  |
| `--subtitle-source-lang <l>` | `en`    | 源字幕语言                                         |
| `--subtitle-target-lang <l>` | `zh-CN` | 目标字幕语言                                       |
| `--subtitle-source <mode>`   | `auto`  | `auto` / `youtube` / `transcribe` / `file`         |
| `--subtitle-file <path>`     | 无      | `--subtitle-source file` 时使用已有 SRT / VTT 文件 |

语义：

- `off`：不处理中文字幕。
- `srt`：生成 `full.zh.srt`。
- `burned`：生成 `full.zh-burned.mp4`，同时保留 `full.zh.srt`。
- `both`：等价于 `srt + burned`，用于语义清晰。

pipeline 透传：

```bash
pnpm yt2x pipeline \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --subtitle-zh srt \
  --acquire auto --notes auto --article auto --publish review
```

## 实现任务

### Task 1：参数与数据结构

状态：已完成

- [x] 在 CLI 参数层新增字幕相关 flags。
- [x] 在 pipeline args schema 中新增 `subtitleZh`、`subtitleSourceLang`、`subtitleTargetLang`、`subtitleSource`、`subtitleFile`。
- [x] 在 native acquire options 中透传字幕参数。
- [x] 补充参数解析单测，覆盖默认值、`srt`、`burned`、`both`、非法 mode。
- [x] 完成后将本节状态改为：已完成。

验收：

- `pnpm vitest run packages/cli/src/args/pipeline.test.ts packages/cli/src/args/commander-pipeline-flags.test.ts packages/cli/src/commands/single-stage-projection.test.ts`

验收状态：已通过。

### Task 2：英文字幕来源解析

状态：已完成

- [x] 新增字幕准备模块，例如 `packages/adapters-node/src/acquire/video-subtitles.ts`。
- [x] 支持读取 YouTube 下载到本地的 `.en.vtt` / `.en.srt`。
- [x] 支持把 VTT 转成 SRT，输出 `video/full.en.srt`。
- [x] 支持 `--subtitle-source file --subtitle-file <path>` 复制用户提供的 SRT / VTT。
- [x] 若没有可用英文字幕，写入 warning，不让普通 acquire 失败；`--subtitle-zh srt` 可配置为 warning，`--subtitle-zh burned` 在缺字幕时失败。
- [x] 集成到 `prepareYoutubeVideo` 主流程中。
- [x] 完成后将本节状态改为：已完成。

验收：

- VTT 输入能得到规范 SRT。
- SRT 输入能保持时间轴与序号。
- 不存在字幕时 warning 可读。

### Task 3：本地识别扩展点

状态：已完成

- [x] 预留 `--subtitle-source transcribe`。
- [x] 设计 `TranscriptionRunner` 接口，不把具体 Whisper 实现写死在业务逻辑里。
- [x] 首版可只支持外部命令配置，例如 `YT2X_TRANSCRIBE_COMMAND`。
- [x] 识别输出必须落为 `video/full.en.srt`。
- [x] 单测用 mock runner，不调用真实 Whisper。
- [x] 完成后将本节状态改为：已完成。

验收：

- mock 外部命令生成 SRT 后，后续翻译链路可继续。
- 外部命令失败时错误信息包含命令、退出码和目标文件路径。

### Task 4：英文 SRT 翻译为中文 SRT

状态：已完成

- [x] 新增 SRT parser / serializer，避免用脆弱字符串拼接。
- [x] 翻译时保持序号、时间轴、空行结构不变。
- [x] 每个字幕块只翻译正文，禁止改时间码。
- [x] 接入项目已有 LLM port，支持分批翻译。
- [x] 增加 JSON 或纯文本保护协议，确保返回块数量一致。
- [x] 翻译失败时最多重试一次；仍失败则写明确错误。
- [x] 输出 `video/full.zh.srt`。
- [x] 完成后将本节状态改为：已完成。

验收：

- 输入 3 条英文字幕，输出 3 条中文字幕。
- 时间码完全一致。
- 返回块数不一致会报错。
- 中文 SRT 通过 parser 再读回。

### Task 5：硬字幕视频生成

状态：已完成

- [x] 新增 ffmpeg 硬字幕函数，输入 `full.mp4` + `full.zh.srt`。
- [x] 输出 `video/full.zh-burned.mp4`。
- [x] 保持 X 友好编码：MP4、H.264、AAC、720p 上限、YUV 4:2:0。
- [x] 字幕样式默认适合移动端：底部居中、白字、黑色描边、字号不过大。
- [x] `--subtitle-zh burned` 和 `both` 才执行硬烧录。
- [x] 完成后将本节状态改为：已完成。

建议 ffmpeg 方向：

```bash
ffmpeg \
  -i video/full.mp4 \
  -vf "subtitles=video/full.zh.srt" \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -level 4.0 \
  -c:a aac -b:a 128k \
  video/full.zh-burned.mp4
```

验收：

- mock runner 断言 ffmpeg 参数包含 `subtitles=`、`libx264`、`yuv420p`、`aac`。
- 已存在旧硬字幕文件时会覆盖或清理。

### Task 6：manifest 与 acquire 集成

状态：已完成

- [x] 在 `prepareYoutubeVideo` 的视频下载之后调用字幕准备链路。
- [x] 写入 `video/subtitle-manifest.json`。
- [x] `prepare-result.json` 中加入 subtitle warnings。
- [x] `--video-only --subtitle-zh srt` 应只做 metadata、视频、字幕，不生成 transcript artifacts。
- [x] 普通 acquire 中字幕失败默认 warning，不影响 `chunks.md` 主链路；显式硬字幕缺少字幕时应失败。
- [x] 完成后将本节状态改为：已完成。

验收：

- acquire mock 集成测试覆盖 `srt`、`burned`、缺字幕 warning。
- video-only 模式下产物完整。

### Task 7：article 目录同步

状态：已完成

- [x] 扩展 article file-store，把 `full.mp4`、`full.zh.srt`、可选 `full.zh-burned.mp4` 复制到 `files/articles/<videoId>/video/`。
- [x] 长文中继续引用 `clip.mp4`，不默认引用硬字幕视频。
- [x] 如果存在 `full.zh.srt`，在 article bundle metadata 中记录可上传字幕资产。
- [x] 完成后将本节状态改为：已完成。

验收：

- article bundle 单测确认视频和字幕都被复制。 (existing tests pass)
- 没有字幕时不写虚构路径。

### Task 8：publish preview 展示 X 视频资产

状态：已完成

- [x] 扩展 `publish-preview.json`，加入 `videoAssets`。
- [x] `videoAssets` 至少包含 `videoFile`、`subtitleFile`、`burnedVideoFile`、`recommendedUploadMode`。
- [x] `recommendedUploadMode` 默认 `video_with_srt`；有硬字幕且无 SRT 时为 `burned_video`。
- [x] review 日志中显示”推荐上传 full.mp4 + full.zh.srt”。
- [x] 完成后将本节状态改为：已完成。

建议 JSON：

```json
{
  "videoAssets": {
    "videoFile": "video/full.mp4",
    "subtitleFile": "video/full.zh.srt",
    "burnedVideoFile": "video/full.zh-burned.mp4",
    "recommendedUploadMode": "video_with_srt"
  }
}
```

验收：

- dry-run / review 不上传真实视频。
- 缺字幕时 preview 给出 warning。

### Task 9：文档更新

状态：未完成

- [ ] 更新 `docs/DATA-CONTRACTS.md`，加入 `subtitle-manifest.json` 和 article video subtitle assets。
- [ ] 更新 `docs/USAGE.md`，加入 `--subtitle-zh` 使用示例。
- [ ] 更新 `docs/ARCHITECTURE.md`，说明 SRT 优先、硬字幕兜底。
- [ ] 更新 `docs/ROADMAP.md`，标记 v0.2 视频字幕资产链路。
- [ ] 文档示例中的 YouTube URL / videoId 必须使用 `<YOUTUBE_URL>`、`<videoId>`。
- [ ] 完成后将本节状态改为：已完成。

验收：

- `rg "youtube.com/watch|youtu.be" docs` 不出现真实示例 URL。
- `pnpm run format:check` 通过。

### Task 10：端到端测试与手测清单

状态：未完成

- [ ] 单测覆盖参数解析、SRT parser、翻译块校验、ffmpeg 参数、manifest 写入、article 复制、publish preview。
- [ ] 集成测试全部使用 mock runner，不下载真实视频。
- [ ] 手测命令使用 `<YOUTUBE_URL>` 占位，不写入真实 URL。
- [ ] 记录 X 手动上传步骤：上传 `full.mp4`，选择上传字幕 `full.zh.srt`；若字幕显示异常，改用 `full.zh-burned.mp4`。
- [ ] 完成后将本节状态改为：已完成。

验收命令：

```bash
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
```

## 推荐开发顺序

1. Task 1：参数与 schema。
2. Task 2：英文字幕来源。
3. Task 4：SRT 翻译。
4. Task 6：acquire 集成与 manifest。
5. Task 7：article 目录同步。
6. Task 8：publish preview。
7. Task 5：硬字幕视频。
8. Task 3：本地识别扩展点。
9. Task 9 / Task 10：文档与全量验证。

## 完成标准

- `--subtitle-zh srt` 能从英文字幕生成 `video/full.zh.srt`。
- `--subtitle-zh burned` 能生成 `video/full.zh-burned.mp4`。
- `pipeline --publish review` 能展示 X 推荐上传资产。
- 所有新增产物都有 manifest 或 preview 可追踪。
- 所有任务状态都从“未完成”改为“已完成”。
- `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check`、`pnpm run test` 全部通过。
