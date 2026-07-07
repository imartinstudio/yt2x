# Bilingual subtitle burn task

版本归属：**v0.3**

## 背景

`docs/X-VIDEO-SUBTITLE-TASK.md` 已定义英文字幕来源、中文 SRT 生成、可选硬字幕视频和发布预览链路。当前硬字幕实现仍以单语中文字幕为主，默认视觉是白字黑底/描边类的移动端可读字幕。

新的目标是把字幕烧制升级为“原英文字幕 + 中文翻译”的双语硬字幕，并采用短视频解释器风格：

```text
source English subtitle
  -> full.en.srt
  -> full.zh.srt
  -> full.bilingual.srt / full.bilingual.ass
  -> full.bilingual-burned.mp4
```

视觉参考：

- 上方中文：大号粗体，亮黄色填充，黑色描边，高对比。
- 下方英文：小号粗体，白色填充，黑色描边/阴影，可偏斜体。
- 整体：中英两行绑定，居中排版，短视频解释器风格，不加独立字幕背景框。

## 目标

新增双语字幕烧制规则：

- 使用原始英文字母字幕作为英文基准，逐句翻译成中文。
- 烧制字幕为中英双语，上方中文、下方英文。
- 中文使用大字号、黄色填充、黑色描边。
- 英文使用小字号、白色填充、黑色描边。
- 覆盖 `SRT / ASS / MP4` 相关产物，保证可复用、可验证、可发布。

## 非目标

- 不自动发布到 X。
- 不提交真实 YouTube URL、真实 videoId、cookies、OAuth token、浏览器凭证或下载产物。
- 不在 CI 下载真实视频或调用真实 ffmpeg 处理真实媒体。
- 不为首版实现复杂逐帧动态避让、人脸检测或画面亮度自适应。
- 不改变已有 `full.zh.srt` 的基础语义：它仍是纯中文字幕资产。

## 已确认决策

| 编号 | 决策点 | v0.3 默认选择 |
| ---- | ------ | ------------- |
| 1 | 输出范围 | 覆盖 `SRT / ASS / MP4`，但主发布硬字幕产物使用 MP4 |
| 2 | 双语顺序 | 中文在上，英文在下 |
| 3 | 英文来源 | 优先使用原始英文字幕；没有英文字幕时沿用现有转写扩展点 |
| 4 | 中文生成 | 基于英文字幕逐句翻译，不合并、不拆分、不重排时间轴 |
| 5 | 翻译风格 | 自然准确，保留技术术语、产品名、命令和 API 名称 |
| 6 | 时间轴 | 中英文共享同一 cue 的时间段 |
| 7 | 中文样式 | 亮黄色、大号、粗体、黑色描边 |
| 8 | 英文样式 | 白色、小号、粗体，可斜体，黑色描边/阴影 |
| 9 | 背景 | 不加独立字幕背景框，靠描边和阴影保证可读性 |
| 10 | 位置 | 底部安全区内整体居中，避免 X 移动端 UI 遮挡 |
| 11 | 长句 | 中文优先一行，英文优先一行；超长时按语义换行，必要时缩小英文 |
| 12 | 兼容 | 保留现有 `full.zh-burned.mp4` 单语能力，新增双语模式 |
| 13 | 验证 | 自动化检查样式/结构/时间轴，人工抽检参考图风格 |

## 产物契约

采集目录：

```text
files/downloads/<videoId>/video/
  full.mp4
  full.en.srt
  full.zh.srt
  full.bilingual.srt
  full.bilingual.ass
  full.bilingual-burned.mp4
  subtitle-manifest.json
```

文章 / 发布目录：

```text
files/articles/<videoId>/video/
  full.mp4
  full.zh.srt
  full.bilingual.srt
  full.bilingual.ass
  full.bilingual-burned.mp4
```

`full.bilingual.srt` 用于人工审阅和兜底：

```text
1
00:00:01,000 --> 00:00:03,500
我制作了整个 Vox 风格的解释器视频
I made this entire Vox style explainer video
```

`full.bilingual.ass` 用于稳定表达中英不同样式。建议首版以 ASS 作为烧制输入，避免在 SRT 中塞样式语义：

```text
[V4+ Styles]
Style: ZhTop,<CJK_FONT>,58,&H0000F4FF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,120,1
Style: EnBottom,<LATIN_FONT>,34,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,1,0,0,100,100,0,0,1,2,1,2,48,48,68,1
```

说明：

- ASS 颜色为 BGR 顺序；`&H0000F4FF` 约等于亮黄色。
- `ZhTop` 与 `EnBottom` 使用不同 `MarginV`，实现中文在英文上方。
- 中文描边建议 3px 左右；英文描边建议 2px 左右。
- 最终参数应根据 720p 输出调优；更高分辨率按视频高度等比缩放。

`subtitle-manifest.json` 建议扩展：

```json
{
  "version": 2,
  "source_video": "video/full.mp4",
  "source_language": "en",
  "target_language": "zh-CN",
  "source_subtitle": "video/full.en.srt",
  "target_subtitle": "video/full.zh.srt",
  "bilingual_subtitle": "video/full.bilingual.srt",
  "bilingual_ass": "video/full.bilingual.ass",
  "burned_video": "video/full.bilingual-burned.mp4",
  "source_method": "youtube_subtitles",
  "translation_method": "llm",
  "burn_style": "bilingual-explainer-v1",
  "warnings": []
}
```

Manifest 兼容策略：

- 读取 manifest 时必须接受现有 `version: 1` 文件。
- 写入双语字段时升级为 `version: 2`，保留已有 `source_*`、`target_*`、`warnings`、`burned_video` 字段。
- `SubtitleManifestV2` 应扩展现有 manifest，而不是让旧 manifest 读取失败。
- `burn-zh-subtitles-for-video.ts` 中现有 `JSON.parse` 后直接更新 `burned_video` 的逻辑不能破坏 `version: 2` 字段。
- 旧 `version: 1` manifest 继续支持单语 `full.zh-burned.mp4`，只有启用双语模式时才写入双语字段。

## CLI 设计

保留现有 `--subtitle-zh`，新增或扩展硬字幕样式参数：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --subtitle-zh both \
  --subtitle-burn-style bilingual-explainer
```

建议参数：

| 参数 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `--subtitle-zh <mode>` | `off` | 继续支持 `off` / `srt` / `burned` / `both` |
| `--subtitle-burn-style <style>` | `zh-default` | `zh-default` / `bilingual-explainer` |
| `--subtitle-bilingual <mode>` | `off` | `off` / `srt` / `ass` / `burned` / `all` |

首版建议：

- `--subtitle-bilingual all` 生成 `full.bilingual.srt`、`full.bilingual.ass`、`full.bilingual-burned.mp4`。
- `--subtitle-burn-style bilingual-explainer` 只影响硬字幕样式，不改变翻译内容。
- 如果不想增加过多参数，可先只加 `--subtitle-bilingual`，并在 `burned/all` 模式下固定使用解释器风格。
- 参数组合必须做交叉校验：当 `--subtitle-burn-style bilingual-explainer` 但 `--subtitle-bilingual off` 时应报错，避免用户以为启用了双语烧制。
- 当 `--subtitle-bilingual burned/all` 启用时，必须确保 `--subtitle-zh` 至少生成 `srt` 所需的中英字幕资产；实现可自动内部提升到等价 `srt` 准备模式，但日志必须明确。

## 技术设计

### 数据流

```text
full.en.srt
  ├─ translateSrt(...) -> full.zh.srt
  ├─ mergeBilingualSrt(en, zh) -> full.bilingual.srt
  ├─ buildBilingualAss(en, zh, style) -> full.bilingual.ass
  └─ burnBilingualSubtitles(video, ass) -> full.bilingual-burned.mp4
```

### 推荐实现路径

优先使用 ASS 作为双语硬字幕烧制格式：

- ASS 原生支持每行不同字体、字号、颜色、描边、斜体和边距。
- 双语 cue 可以拆成两条同时间段 Dialogue：一条中文样式、一条英文样式。
- ffmpeg 可直接通过 `subtitles=<assPath>` 烧制，减少当前 PNG 序列 overlay 的复杂度。

首版采用“新增独立 ASS 烧制路径”，不替换现有 PNG 单语路径：

- 新增 `burn-bilingual-subtitles.ts`，封装 `burnBilingualSubtitles()`。
- 现有 `burn-subtitles.ts` / `render-subtitles.py` 继续服务 `full.zh-burned.mp4` 单语路径。
- 双语路径可以复用现有 SRT integrity 校验和 `verifyBurnedSubtitles()` 后置验证，但不复用 PNG 渲染流程。
- 不在本任务中重构 `burn-subtitles.ts` 的 PNG pipeline，避免把单语稳定路径和双语新能力耦合。

PNG 渲染只作为后续兜底方案：

- 如果目标环境 ASS 字体或 ffmpeg subtitles filter 表现不稳定，再扩展 `render-subtitles.py` 做双语渲染。
- PNG 路径的缺点是样式参数需要 Python/PIL 维护，且每个 cue 生成图片后再 overlay，验证和性能更复杂。

### 字幕合并规则

`full.en.srt` 与 `full.zh.srt` 必须满足：

- cue 数量一致。
- cue index 一致。
- start/end 时间一致，允许最多 5ms 格式化误差。
- 任一 cue 中文或英文为空时失败；普通采集模式可降级为 warning，显式 `burned/all` 模式必须失败。

`full.bilingual.srt` 文本规则：

- 第一行中文，第二行英文。
- 中文去除源字幕窄换行造成的多余空格。
- 英文保留自然英文空格和大小写。
- 不把 ASS 样式标签写入 SRT。

`full.bilingual.ass` Dialogue 规则：

```text
Dialogue: 0,0:00:01.00,0:00:03.50,ZhTop,,0,0,0,,我制作了整个 Vox 风格的解释器视频
Dialogue: 0,0:00:01.00,0:00:03.50,EnBottom,,0,0,0,,I made this entire Vox style explainer video
```

### 样式参数

以 1280x720 为基准：

| 项 | 中文 | 英文 |
| -- | ---- | ---- |
| 字号 | 56-62 | 32-38 |
| 字重 | Bold | Bold |
| 斜体 | 否 | 是 |
| 填充色 | `#FFF400` 或接近亮黄 | `#FFFFFF` |
| 描边 | 黑色 3px | 黑色 2px |
| 阴影 | 1px 可选 | 1px 可选 |
| 对齐 | 底部居中 | 底部居中 |
| 垂直边距 | 110-130 | 60-75 |
| 最大宽度 | 视频宽度 88%-92% | 视频宽度 88%-92% |

分辨率缩放：

- 720p 使用上表基准。
- 1080p 按 `videoHeight / 720` 等比放大字号、描边、边距。
- 低于 720p 时保持最小中文 42px、英文 26px，避免过小。

字体建议：

- 中文优先：`Hiragino Sans GB`、`PingFang SC`、`STHeiti`。
- 英文优先：`Arial`、`Helvetica Neue`、`Arial Unicode`。
- 字体不存在时记录 warning，并回退到系统可用字体。
- ASS 烧制使用 ffmpeg/libass，字体发现必须显式处理：优先探测系统字体路径并传入 `fontsdir`，无法找到目标字体时记录 warning 并回退到 ASS `FontName`。
- 单测不依赖真实字体文件；只断言字体发现结果会进入 `subtitles=...:fontsdir=...` 或 warning。

### Force 与增量生成

双语产物必须遵守现有 `--force` 语义：

- `--force` 为 true 时，重新生成 `full.bilingual.srt`、`full.bilingual.ass` 和 `full.bilingual-burned.mp4`。
- 未传 `--force` 时，如果双语 MP4 已存在且比 `full.en.srt`、`full.zh.srt`、`full.bilingual.ass` 都新，则跳过烧制。
- 如果任一源字幕或 ASS 比双语 MP4 新，删除旧双语 MP4 并重新烧制。
- 如果 `full.bilingual.srt` 或 `full.bilingual.ass` 缺失，但源中英 SRT 存在，应补生成缺失资产。
- 跳过、重烧、缺资产失败都必须写入日志或 manifest warning，便于诊断。

## 实现任务

### Task 1：参数与模式建模

状态：待开始

- [ ] 在 CLI 参数层新增 `--subtitle-bilingual <mode>`，可选值 `off` / `srt` / `ass` / `burned` / `all`。
- [ ] 新增 `--subtitle-burn-style <style>`，可选值 `zh-default` / `bilingual-explainer`。
- [ ] 在 `AcquireOptionsSchema` 中新增双语字段，并用 `superRefine` 校验 `--subtitle-burn-style bilingual-explainer` 必须配合非 `off` 的 `--subtitle-bilingual`。
- [ ] 在 pipeline args、single-stage flags、subtitle 命令 flags 中透传双语参数。
- [ ] 更新参数解析单测，覆盖默认值、合法值、非法值。
- [ ] 更新 acquire、pipeline、subtitle 三个命令入口的 option 定义。

涉及文件：

- `packages/cli/src/args/pipeline.ts`
- `packages/cli/src/args/pipeline.test.ts`
- `packages/cli/src/args/commander-pipeline-flags.ts`
- `packages/cli/src/args/commander-pipeline-flags.test.ts`
- `packages/cli/src/commands/acquire.ts`
- `packages/cli/src/commands/pipeline.ts`
- `packages/cli/src/commands/subtitle.ts`
- `packages/cli/src/commands/command-flags.ts`
- `packages/cli/src/commands/single-stage-projection.ts`
- `packages/cli/src/commands/single-stage-projection.test.ts`
- `packages/cli/src/orchestrator/native-subtitle.ts`
- `packages/cli/src/orchestrator/native-acquire-from-pipeline-args.ts`
- `packages/cli/src/orchestrator/native-pipeline.ts`

验收：

```bash
pnpm test packages/cli/src/args packages/cli/src/commands/single-stage-projection.test.ts
```

### Task 2：双语字幕结构生成

状态：待开始

- [ ] 新增双语字幕模块，例如 `packages/adapters-node/src/acquire/bilingual-subtitles.ts`。
- [ ] 实现 `mergeBilingualSrt(enSrt, zhSrt)`，输出中文在上、英文在下的 SRT。
- [ ] 实现 cue 对齐校验：数量、index、start/end。
- [ ] 为空文本、错位时间轴、数量不一致分别返回可诊断错误。
- [ ] 补充单测覆盖正常合并、英文保留、中文在上、错位失败。

涉及文件：

- `packages/adapters-node/src/acquire/bilingual-subtitles.ts`
- `packages/adapters-node/src/acquire/bilingual-subtitles.test.ts`
- `packages/adapters-node/src/acquire/index.ts`

验收：

```bash
pnpm test packages/adapters-node/src/acquire/bilingual-subtitles.test.ts
```

### Task 3：ASS 生成器

状态：待开始

- [ ] 在双语字幕模块中实现 `buildBilingualAss(enSrt, zhSrt, styleOptions)`。
- [ ] 为 `bilingual-explainer-v1` 固定输出中文 `ZhTop` 与英文 `EnBottom` 两套 Style。
- [ ] 将每个 cue 生成两条同时间段 Dialogue。
- [ ] 对 ASS 特殊字符做转义，避免 `{}`、`\N`、逗号破坏格式。
- [ ] 实现字体配置输入：中文字体、英文字体、可选 `fontsdir`。
- [ ] 补充单测断言黄色中文 `&H0000F4FF`、白色英文 `&H00FFFFFF`、黑色描边、英文斜体、中文在上。
- [ ] 补充单测锁定 ASS 颜色顺序，避免把 RGB 误写成 BGR。

涉及文件：

- `packages/adapters-node/src/acquire/bilingual-subtitles.ts`
- `packages/adapters-node/src/acquire/bilingual-subtitles.test.ts`

验收：

```bash
pnpm test packages/adapters-node/src/acquire/bilingual-subtitles.test.ts
```

### Task 4：双语烧制实现

状态：待开始

- [ ] 新增 `burnBilingualSubtitles`，使用独立 ASS 路径 `ffmpeg -vf subtitles=<assPath>` 烧制，不替换现有 PNG 单语路径。
- [ ] 函数签名包含 `videoPath`、`assPath`、`outputPath`、`runner`、`force`、可选 `fontsDir`、可选 `signal`。
- [ ] 输出 `video/full.bilingual-burned.mp4`。
- [ ] 保持 H.264 + AAC + yuv420p + faststart。
- [ ] 支持 `--force`：force 时无条件重烧；非 force 时按源字幕/ASS/输出 MP4 的 mtime 判断是否跳过。
- [ ] 支持文章目录输出：调用方可以把 `outputPath` 指向 `files/articles/<videoId>/video/full.bilingual-burned.mp4`，与现有 `burnedVideoOutDir` 语义一致。
- [ ] 复用现有 `validateSrtIntegrity` 或等价 cue 校验，烧制后复用 `verifyBurnedSubtitles()` 做抽帧差异验证。
- [ ] 处理 ffmpeg `subtitles` filter 路径转义和 `fontsdir` 参数；字体不可用时记录 warning。
- [ ] 单测 mock runner，断言 ffmpeg 参数包含 ASS 路径、编码参数和输出路径。
- [ ] 单测 mock runner 示例必须覆盖：已有输出跳过、force 重烧、ASS 比 MP4 新时重烧、`fontsdir` 进入 filter。
- [ ] 不在 CI 调用真实 ffmpeg。

涉及文件：

- `packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts`
- `packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts`
- `packages/adapters-node/src/acquire/index.ts`

验收：

```bash
pnpm test packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts
```

### Task 5：接入字幕准备链路

状态：待开始

- [ ] 在现有字幕准备流程中，当 `--subtitle-bilingual srt/ass/burned/all` 开启时生成双语产物。
- [ ] 保证 `full.en.srt` 和 `full.zh.srt` 仍按现有逻辑生成。
- [ ] `all` 模式生成 `full.bilingual.srt`、`full.bilingual.ass`、`full.bilingual-burned.mp4`。
- [ ] 新增 `SubtitleManifestV2` 类型，向后兼容读取 `version: 1` manifest。
- [ ] 写入双语字段时升级 `subtitle-manifest.json` 至 `version: 2`，追加双语字段和 `burn_style`，保留旧字段。
- [ ] 确保 `burn-zh-subtitles-for-video.ts` 更新单语 `burned_video` 时不会删除 `version: 2` 的双语字段。
- [ ] 将双语产物同步到 `files/articles/<videoId>/video/`。
- [ ] 双语 burned/all 模式下继承 `--force` 逻辑：字幕更新或 ASS 更新时自动重烧，force 时强制重烧。

涉及文件：

- `packages/adapters-node/src/acquire/video-subtitles.ts`
- `packages/adapters-node/src/acquire/video-subtitles.test.ts`
- `packages/adapters-node/src/acquire/burn-zh-subtitles-for-video.ts`
- `packages/adapters-node/src/acquire/burn-zh-subtitles-for-video.test.ts`
- `packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts`

验收：

```bash
pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts packages/adapters-node/src/acquire/burn-zh-subtitles-for-video.test.ts
```

### Task 6：发布预览与文档

状态：待开始

- [ ] 在 publish review 中展示双语 SRT、ASS、双语硬字幕 MP4。
- [ ] 修改 `resolveVideoAssets()`：识别 `full.bilingual-burned.mp4`、`full.bilingual.srt`、`full.bilingual.ass`。
- [ ] 当双语硬字幕存在时，优先推荐发布 `full.bilingual-burned.mp4`；其次才是 `full.zh-burned.mp4`；再次是 `full.mp4 + full.zh.srt`。
- [ ] `VideoAssetsInfo` 增加双语字段，例如 `bilingualSubtitleFile`、`bilingualAssFile`、`bilingualBurnedVideoFile`，publish preview 中展示这些资产。
- [ ] 更新 `docs/DATA-CONTRACTS.md` 的视频字幕产物契约。
- [ ] 更新 `docs/USAGE.md`，示例 URL 必须使用 `<YOUTUBE_URL>`。

涉及文件：

- `packages/cli/src/orchestrator/native-publish.ts`
- `packages/cli/src/orchestrator/native-publish.test.ts`
- `docs/DATA-CONTRACTS.md`
- `docs/USAGE.md`

验收：

```bash
pnpm test packages/cli/src/orchestrator/native-publish.test.ts
pnpm format:check
```

### Task 7：视觉验收脚本与人工抽检

状态：待开始

- [ ] 复用现有 `verifyBurnedSubtitles()` 的 start/middle/end 抽帧与像素差异检查。
- [ ] 如双语字幕区域更高，调整验证脚本的检测区域，确保中文和英文两行都进入比较范围。
- [ ] 人工抽检至少 3 个不同背景片段：暗背景、亮背景、复杂 UI 背景。
- [ ] 人工验收项：中文黄色醒目、英文白色可读、黑边清晰、没有背景框、字幕不遮挡主体 UI。

涉及文件：

- `packages/adapters-node/src/acquire/verify-subtitles.py`
- `packages/adapters-node/src/acquire/burn-subtitles.ts`
- `packages/adapters-node/src/acquire/burn-bilingual-subtitles.ts`

验收：

```bash
pnpm test packages/adapters-node/src/acquire/burn-subtitles.test.ts packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts
```

人工命令示例：

```bash
pnpm yt2x acquire \
  --urls "<YOUTUBE_URL>" \
  --download-video \
  --subtitle-zh both \
  --subtitle-bilingual all
```

## 验收标准

功能验收：

- 给定英文 SRT 和中文 SRT，可以生成 `full.bilingual.srt`。
- 给定英文 SRT 和中文 SRT，可以生成 `full.bilingual.ass`。
- 双语 ASS 中每个 cue 都有中文和英文两条 Dialogue。
- 双语硬字幕视频输出为 `full.bilingual-burned.mp4`。
- manifest 能记录双语 SRT、ASS、硬字幕 MP4 和样式版本。
- 发布预览能识别并优先推荐 `full.bilingual-burned.mp4`。

视觉验收：

- 中文在英文上方。
- 中文明显大于英文，约为英文 1.6 倍。
- 中文为亮黄色，黑色描边清晰。
- 英文为白色，黑色描边/阴影清晰。
- 不出现独立半透明背景框。
- 在 720p 移动端预览中仍可读。
- 长句不会溢出画面左右安全区。

兼容验收：

- 未启用双语参数时，现有 `full.zh.srt` 和 `full.zh-burned.mp4` 行为不变。
- 旧 `version: 1` manifest 可正常读取；写入双语字段时升级到 `version: 2`。
- `--force` 与字幕 mtime 更新能触发双语 ASS/MP4 重生成。
- 没有英文字幕且转写不可用时，普通采集可写 warning；显式双语 burned/all 模式应失败并给出清晰错误。
- CI 测试不依赖真实视频、真实 YouTube、真实 ffmpeg 处理。

## 最小验证命令

```bash
pnpm test packages/adapters-node/src/acquire/bilingual-subtitles.test.ts
pnpm test packages/adapters-node/src/acquire/burn-bilingual-subtitles.test.ts
pnpm test packages/adapters-node/src/acquire/video-subtitles.test.ts
pnpm test packages/cli/src/args packages/cli/src/commands/single-stage-projection.test.ts
pnpm test packages/cli/src/orchestrator/native-publish.test.ts
pnpm run typecheck
pnpm format:check
```

## 风险与注意事项

- ffmpeg `subtitles` filter 对字体发现和路径转义敏感，文件路径中包含空格、冒号或引号时必须测试。
- ASS 颜色顺序不是 RGB，而是 BGR，黄色参数需要单测锁定。
- 英文字幕过长时，英文行最容易横向溢出；首版应先限制最大宽度并允许英文换行。
- 当前 PNG overlay 路径会把字幕区域作为独立透明图层；如果改用 ASS 烧制，验证脚本需要兼容新路径。
- 参考图风格强调强描边。虽然用户口径是“黑色细线描边”，实际落地应以可读性优先：中文描边可略重于英文。
