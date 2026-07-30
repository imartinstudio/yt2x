# 中文配音（dub）任务设计

> 状态：PR1 已完成、已验收，改动留在工作区未 commit。整体目标与约束由 2026-07-30 的
> 需求澄清确定，见「已锁定的决策」。

## 当前状态

- 分支 `feature/dub-script-and-tts-port`
- **PR1 已 commit**（`dffcba5`）：配音稿 + TtsPort + edge-tts
- **PR2 已实现、未 commit**：Demucs + 时长协商 + 反向 SRT + 混音重烧 → `full.zh-dubbed.mp4`
- 验证：`pnpm test packages/core/src/domain/dub packages/adapters-node/src/dub`（133）/
  `typecheck` / `lint` 均通过
- 本机未装 demucs 时，完整成片路径会在探测阶段硬失败；`--script-only` /
  `--timing-only` 仍可在无 demucs 环境下取数

## 目标

给已经跑完 `acquire` + `subtitle` 的视频生成中文配音成片：替换原声、保留背景音、
按最终配音稿重烧字幕，产出 `full.zh-dubbed.mp4`。

## 已锁定的决策

| #   | 决策点             | 结论                                                                          |
| --- | ------------------ | ----------------------------------------------------------------------------- |
| 1   | 成片形态           | 替换原声 + Demucs 分离保留 BGM/音效                                           |
| 2   | 对齐策略           | 混合：调速（引擎支持区间内）→ LLM 改短 → 顺延，并在原片自然停顿处吸收累积漂移 |
| 3   | TTS 抽象           | `TtsPort` 进 core；两个适配器：edge-tts（默认、调试）+ ElevenLabs（成片）     |
| 4   | 配音稿             | `full.zh.srt` 按自然句合并 → LLM 朗读化改写 → 按句合成                        |
| 5   | 字幕               | 用最终配音稿 + TTS 实测时长反向生成新 zh SRT 再烧                             |
| 6   | 音色               | 全片单一音色，不做 diarization                                                |
| 7   | CLI                | 独立 `yt2x dub` + pipeline `--dub` 开关（默认关）                             |
| 8   | 产物               | 只出 `full.zh-dubbed.mp4`；开 `--dub` 时 subtitle 阶段只翻译、不烧录          |
| 9   | Demucs 缺失        | 硬失败退出，探测放在任何计费调用之前                                          |
| 10  | 门禁               | 硬阈值阻断 + `dub-report.json`                                                |
| 11  | 收尾漂移           | 冻结末帧延长视频                                                              |
| 12  | 原片已有中文硬字幕 | 沿用 `skipBurnIfChineseBurned` 逻辑，检测到就只配音、不烧字幕                 |

## 关键约束（来自现有代码，不是假设）

- `srt-translator.ts` 对源字幕保持严格 1:1 映射，**不保证句末标点**。YouTube 自动字幕
  常常整片零标点，所以合并自然句不能只靠标点，必须有间隔兜底。
- `full.zh.srt` 是按屏宽切的（每条 15–20 字）。按条喂 TTS 会硬断气。
- 各引擎表达语速的方式不同（edge-tts 用 `--rate=+10%` 字符串，ElevenLabs 用浮点
  且区间更窄）。端口统一用倍率，由适配器映射，并用 `rateRange` 声明真实区间。
- Python 侧脚本 + `ProcessRunner` 是仓库既有模式（`acquire/` 下已有 8 个 `.py`），
  Demucs 按同一模式接入。

## PR 切分

### PR1（本次）：配音稿 + TtsPort + edge-tts，不碰视频

产出 `dub-script.json` 与逐句音频，**核心目的是拿到真实时长分布**——PR3 的门禁阈值
必须从这批数据定，拍脑袋的阈值会全错。

新增文件：

```text
packages/core/src/ports/tts.ts                  TtsPort / TtsError / clampRate
packages/core/src/domain/dub/types.ts           DubCue / DubSegment / DubScript / DubTimingReport
packages/core/src/domain/dub/segment.ts         SRT 时间戳互转 + mergeCuesIntoSegments（纯函数）
packages/core/src/domain/dub/prompts.ts         朗读化改写 prompt
packages/core/src/domain/dub/index.ts
packages/adapters-node/src/dub/edge-tts.ts      TtsPort 实现，走 ProcessRunner
packages/adapters-node/src/dub/script.ts        调 LLM 生成配音稿
packages/adapters-node/src/dub/synthesize.ts    逐句合成 + ffprobe 实测时长 + 汇总报告
packages/adapters-node/src/dub/file-store.ts    读 full.zh.srt，写 dub-script.json / 音频 / 报告
packages/adapters-node/src/dub/index.ts
packages/cli/src/commands/dub.ts                Commander 薄层
packages/cli/src/orchestrator/native-dub.ts     编排 + 退出码
```

产物布局（沿用 `files/articles/<videoId>/` 约定）：

```text
files/articles/<videoId>/dub/
  dub-script.json        配音稿（含每行目标时长、改写前后文本）
  dub-timing.json        实测时长报告（倍率 1.0），PR3 定阈值的数据源
  lines/0001.mp3 ...     逐句音频
```

朗读化改写的硬规则（写进 prompt）：

1. 只做朗读化，不重新翻译，不增删信息点。
2. 专有名词 / 品牌名 / 命令 / 代码标识符原样保留（与 `srt-translator.ts` 规则一致）。
3. 百分比、倍数、单位改成中文读法；版本号与型号（GPT-4、Claude 3.5）保持原样。
4. 删除括注和给读者的旁注。
5. 书面连接词换口语；必要时补主语让句子能独立听懂。
6. **长度不得显著超过原句**——混合策略靠这条兜底。
7. 返回 JSON 数组，`index` 与输入一一对应。

不在 PR1 范围：Demucs、时长协商、混音、反向 SRT、重烧、门禁阈值、pipeline 集成、
ElevenLabs 适配器。PR1 的时长报告只记录不阻断。

### PR2：Demucs + 时长协商 + 反向 SRT + 混音重烧

出 `full.zh-dubbed.mp4`。Demucs 探测前置于任何 TTS / LLM 计费调用。

新增 / 扩展：

```text
packages/core/src/domain/dub/negotiate.ts       时长协商规划（纯函数）
packages/core/src/domain/dub/reverse-srt.ts     反向 SRT
packages/core/src/domain/dub/shorten-prompts.ts LLM 改短 prompt
packages/adapters-node/src/dub/demucs-separate.py
packages/adapters-node/src/dub/demucs.ts        探测 + 分离
packages/adapters-node/src/dub/negotiate.ts     执行协商（调速 / 改短 / 顺延）
packages/adapters-node/src/dub/remix.ts         人声轨 + BGM 混音 + 冻结末帧 + 可选重烧
packages/cli/src/orchestrator/native-dub.ts     全链路编排
```

产物追加：

```text
files/articles/<videoId>/dub/
  dub-plan.json          协商计划
  dub-placement.json     最终落点
  demucs/no_vocals.wav   BGM/音效
  voice.wav / mixed.m4a  中间音轨
files/articles/<videoId>/video/
  full.zh-dub.srt        反向字幕
  full.zh-dubbed.mp4     成片
```

协商顺序：keep → speed（≤1.15× ∩ 引擎 rateRange）→ LLM 改短 → 顺延；
漂移在原片自然停顿处吸收，片尾残留用冻结末帧延长。原片已有中文硬字幕时只配音不烧字幕。
门禁阈值仍只记录不阻断（PR3）。

### PR3：ElevenLabs 适配器 + 门禁阈值 + pipeline `--dub`

阈值取自 PR1/PR2 的真实数据；`--dub` 开启时自动把 subtitle 阶段降为「只翻译」。

## 待定（PR1 不解决）

- ElevenLabs 的 `speed` 参数在不同模型上区间不一致，接适配器前需查当前 API 文档确认。
- edge-tts 首选音色暂定 `zh-CN-YunxiNeural`，PR1 跑完试听后再定。
- 门禁各项硬阈值的具体数值。
