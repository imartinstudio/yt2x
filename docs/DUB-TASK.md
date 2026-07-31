# 中文配音（dub）任务设计

> 状态：PR1–PR3 均已实现。整体目标与约束由 2026-07-30 的需求澄清确定，见「已锁定的决策」。

## 当前状态

- 分支 `feature/dub-script-and-tts-port`
- **PR1 已 commit**（`dffcba5`）：配音稿 + TtsPort + edge-tts
- **PR2 已 commit**（`3982050`）：Demucs + 时长协商 + 反向 SRT + 混音重烧
- **PR3 已 commit**：ElevenLabs 适配器 + 门禁 + pipeline `--dub`
- 验证：dub/gate/elevenlabs/pipeline 相关单测与 `typecheck` / `lint` 通过

## 目标

给已经跑完 `acquire` + `subtitle` 的视频生成中文配音成片：替换原声、保留背景音、
按最终配音稿重烧字幕，产出 `full.zh-dubbed.mp4`。

## 已锁定的决策

| #   | 决策点             | 结论                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 成片形态           | 替换原声 + Demucs 分离保留 BGM/音效                                                                                                                                                                                                                                                                                                                                              |
| 2   | 对齐策略           | 混合：调速（引擎支持区间内）→ LLM 改短 → 顺延，并在原片自然停顿处吸收累积漂移。<br>**句间硬约束**：相邻落点间隔 ≥ `minInterSentencePauseMs`（默认 150ms，120–200 试听后可调）。<br>**停顿 vs 压缩**：未触 `extendMs` 封顶时停顿优先、漂移由片尾冻结吸收；触顶后才允许从目标槽借时间压缩，且优先压缩而不是砍停顿。<br>`extendMs` 封顶 = `min(maxExtendMs=8s, videoDuration×2%)`。 |
| 3   | TTS 抽象           | `TtsPort` 进 core；两个适配器：edge-tts（默认、调试）+ ElevenLabs（成片）                                                                                                                                                                                                                                                                                                        |
| 13  | 语音时长来源       | **唯一来源**：引擎词/短语时间戳（edge-tts `--write-subtitles`；ElevenLabs 须真调验证后再接）。`synthesizedMs = speechEnd − speechStart`，扣掉前置 padding。<br>**ffprobe 降级为交叉校验**：时间戳语音终点不得超过音频文件实际时长，失败显式报错，禁止静默退回整文件时长。                                                                                                        |
| 14  | 门禁句间间隔       | 新增零间隔 / 低于最小停顿的指标；`maxZeroGapFraction=0`、`maxLowGapFraction=0`（硬）。阈值用真实素材从零标定，不沿用旧 smoke。                                                                                                                                                                                                                                                   |
| 4   | 配音稿             | `full.zh.srt` 按自然句合并 → LLM 朗读化改写 → 按句合成                                                                                                                                                                                                                                                                                                                           |
| 5   | 字幕               | 用最终配音稿 + TTS 实测时长反向生成新 zh SRT 再烧                                                                                                                                                                                                                                                                                                                                |
| 6   | 音色               | 全片单一音色，不做 diarization                                                                                                                                                                                                                                                                                                                                                   |
| 7   | CLI                | 独立 `yt2x dub` + pipeline `--dub` 开关（默认关）                                                                                                                                                                                                                                                                                                                                |
| 8   | 产物               | 只出 `full.zh-dubbed.mp4`；开 `--dub` 时 subtitle 阶段只翻译、不烧录                                                                                                                                                                                                                                                                                                             |
| 9   | Demucs 缺失        | 硬失败退出；**需要出片的路径上**，探测前置于任何计费调用（`--script-only` / `--timing-only` 不要求安装 Demucs）                                                                                                                                                                                                                                                                  |
| 10  | 门禁               | 硬阈值阻断 + `dub-report.json`                                                                                                                                                                                                                                                                                                                                                   |
| 11  | 收尾漂移           | 冻结末帧延长视频                                                                                                                                                                                                                                                                                                                                                                 |
| 12  | 原片已有中文硬字幕 | **字幕流程**：沿用 `skipBurnIfChineseBurned`，检测到就跳过烧录以免叠两层。<br>**配音流程**：拒绝执行并明确报错（时间轴冲突）；检测前置于 Demucs / LLM 改写 / TTS。                                                                                                                                                                                                               |

## 关键约束（来自现有代码，不是假设）

- `srt-translator.ts` 对源字幕保持严格 1:1 映射，**不保证句末标点**。YouTube 自动字幕
  常常整片零标点，所以合并自然句不能只靠标点，必须有间隔兜底。
- `full.zh.srt` 是按屏宽切的（每条 15–20 字）。按条喂 TTS 会硬断气。
- 各引擎表达语速的方式不同（edge-tts 用 `--rate=+10%` 字符串，ElevenLabs 用浮点
  且区间更窄）。端口统一用倍率，由适配器映射，并用 `rateRange` 声明真实区间。
- Python 侧脚本 + `ProcessRunner` 是仓库既有模式（`acquire/` 下已有 8 个 `.py`），
  Demucs 按同一模式接入。

## PR 切分

### PR1：配音稿 + TtsPort + edge-tts，不碰视频

（已完成，见 git history。）

### PR2：Demucs + 时长协商 + 反向 SRT + 混音重烧

（已完成。）协商顺序：keep → speed（≤1.15× ∩ 引擎 rateRange）→ LLM 改短 → 顺延。

### PR3：ElevenLabs 适配器 + 门禁阈值 + pipeline `--dub`

```text
packages/adapters-node/src/dub/elevenlabs.ts    TtsPort；speed 0.7–1.2
packages/core/src/domain/dub/gate.ts            硬/咨询阈值 + evaluateDubGate
packages/cli/.../native-dub.ts                  --dub-engine、门禁阻断、dub-report.json
packages/cli/.../pipeline.ts                    --dub / --dub-engine
packages/cli/.../native-pipeline.ts             --dub → subtitle 只翻译；article 后跑 dub
```

- `yt2x dub` 默认 `edge-tts`；`yt2x pipeline --dub` 默认 `elevenlabs`
- ElevenLabs：`ELEVENLABS_API_KEY` + `--voice` / `ELEVENLABS_VOICE_ID`
- 门禁写出 `dub/dub-report.json`；hard issue 阻断成片（`--skip-gate` 仅调试）
- 默认硬阈值（#113，`A8mokin_YOs` 30s 窗从零标定）：`maxExtendMs=8s`、
  `maxDelayFraction=35%`、`minTextRetainFraction=45%`、`maxZeroGapFraction=0`、
  `maxLowGapFraction=0`；`advisoryOverflowFraction=75%`；medianRatio 仅 advisory
- ElevenLabs 时间戳：本机 `.env` 无 API key，**尚未真调验证**；在验证前
  适配器不返回 `speechTiming`，合成路径会显式失败（禁止静默降级）

## 待定（可后续调）

- 最小句间停顿默认 150ms，120–200ms 试听后锁定
- ElevenLabs `with-timestamps` 真调通过后再接入 `speechTiming`
- 门禁硬阈值在更多真实片子上按分布再收紧
- edge-tts / ElevenLabs 默认音色试听后再定
