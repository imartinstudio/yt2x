# ADR-0006: 交付物是单一互斥枚举，配音是最高一档

- **Status**: Accepted
- **Date**: 2026-08-03
- **Deciders**: 项目负责人
- **Tags**: cli, subtitles, dub, defaults, validation
- **实现状态**: 决策已定，代码尚未落地

## Context

「这次要交付什么」此前由三个正交参数编码：

| 参数                    | 取值数 | 实际不同行为数            |
| ----------------------- | ------ | ------------------------- |
| `--subtitle-zh`         | 4      | 3（`both` ≡ `burned`）    |
| `--subtitle-bilingual`  | 5      | 4（`all` ≡ `burned`）     |
| `--subtitle-burn-style` | 2      | **1**（对成片无任何影响） |

`--subtitle-burn-style` 的值只写进 manifest 的 `burn_style` 字段，没有任何代码读回它改变
渲染；唯一看似生效的分支两侧完全相同。`--subtitle-zh both` 与 `--subtitle-bilingual all`
分别与各自的 `burned` 产出完全一致。

配音则是第四个正交开关 `--dub`，由此产生三处**静默否决**：

- 开了 `--dub`，`--subtitle-bilingual burned` 被静默关掉。
- 同时给 `--subtitle-zh burned` 和 `--subtitle-bilingual burned`，中文单语烧录被静默丢弃。
- `--subtitle-source auto` 在找不到 YouTube 字幕时静默回退到句级本地转录——一条永远配不了
  音的通道。

行为本身是对的（交付只应烧录一次），但命令行上看不出来：用户传了参数，它无声地不生效。

配音还带来两个「不显式传就必然失败」的默认值：`pipeline` 的 TTS 引擎默认 ElevenLabs
（`args/pipeline.ts` 的 schema 默认值），而同一能力的 `dub` 子命令默认 edge-tts；demucs 需要
`--python-path`，因为解释器候选列表里没有 venv 路径。

## Decision

### 1. 交付物是一个必填的互斥枚举

`yt2x video --deliver <mode>`，取值见 [CONTEXT.md](../../CONTEXT.md) 的「交付物」六档：
`none` / `zh-srt` / `zh-burned` / `bilingual-srt` / `bilingual-burned` / `dubbed`。

`--subtitle-zh`、`--subtitle-bilingual`、`--subtitle-burn-style`、`--dub` 全部删除。

**不设默认值**。该参数决定一次 16~20 分钟、且要调用 LLM 的任务产出什么，用户应当在按下回车
之前就知道结果。按源语言推断默认值的方案被拒绝：源语言要下载并开始转录之后才测得出来，
把默认值绑在一个「跑起来几分钟后才知道」的事实上，等于把不确定性放在最贵的位置。

### 2. 配音是这条阶梯的最高一档，不是正交开关

`dubbed` 是 `--deliver` 的一个取值，因此**在结构上不可能**与其他交付档同时给出，三处静默
否决连同实现它们的分支一并删除。

`--deliver dubbed` 隐含 `--from local-words`（词级本地转录通道，配音的唯一前提）。

### 3. 显式矛盾一律报错，绝不静默改写

显式给出的互相矛盾的参数必须报错并说明原因，例如
`--deliver dubbed --from youtube` → 「YouTube 字幕没有词级时间戳，无法配音」。
未指定时才使用默认值，且默认值的选用记录到日志。

### 4. 缺少所需的转录产物时自动补跑

`yt2x video` 按 `--deliver` 与 `--from` 推出需要哪种转录产物，缺则自动生成，已存在则跳过。
本地转录不联网、不花钱，写入的是 `full.local.<lang>.*` 旁挂文件（`AGENTS.md` 明确允许的
例外）。此前要求用户显式先跑 `subtitle transcribe-local` 的注释，约束的是「错误不许被吞」，
不是「必须由人触发」——自动补跑同样满足它：失败即报错中止，不降级、不吞错。

### 5. 默认值按「能跑通」定，环境路径不做成参数

- TTS 引擎统一默认 `edge-tts`。ElevenLabs 不是「更高质量的默认」，而是在没有账号时**必然
  失败**的默认，产不出任何一次成功交付。
- `--python-path` 删除，改为按能力探测（补齐 `resolvePythonWithDemucs`，候选列表加入
  `.venv-demucs/bin/python3`）。该参数的前提是错的：Pillow、faster-whisper、demucs 是三种
  不同的能力需求，可能分散在不同解释器里，一个路径无法同时满足。

## Consequences

### Positive

- 三处静默否决在结构上消失，而不是「被报错拦住」。
- 死取值与无作用参数（`both` / `all` / `--subtitle-burn-style`）随枚举合并一并清除。
- 配音从「需要同时知道三个隐式前提才能用」变成一个可直接选择的交付档。
- 用户在按下回车前就知道会拿到什么。

### Negative

- `--deliver` 必填，最常用的路径也要多写一个参数。
- 「同时产出中文单语字幕文件与双语硬字幕成片」这一组合无法表达。该组合在旧实现中同样拿不到
  （会被静默否决），因此不算功能退化；若将来确有需要，可放宽为逗号分隔多值，代价是失去
  「结构上不可能矛盾」这一性质。
- 自动补跑转录会让一次 `yt2x video` 的耗时变长且不易预估。

## Alternatives Considered

### 1. 保留正交参数，用 zod 拒绝非法组合

拒绝。这只是把静默换成报错，病灶还在：用户仍然必须先构造出矛盾才会被拦。互斥枚举让矛盾无法
被表达出来。

### 2. `--dub` 保留为独立布尔开关

拒绝。它与字幕参数表达的是同一件事——「成片里烧什么」，正交化必然要靠否决规则来收拾。

### 3. 配音完全留在独立的 `yt2x dub` 命令

拒绝。用户需要记住「配音前必须把字幕交付关掉，否则会烧两次」，等于把今天由代码隐式执行的
规则搬进人的脑子里。

### 4. 复合 spec 字符串（`--deliver bilingual:burned`）

拒绝。要自己写解析和错误提示，换来的扩展性在一共六档的取值空间里用不上。

### 5. 把两种本地转录统一成一条通道

暂缓。句级转录（whisper-cli）依赖轻、是当前主力路径；词级转录（faster-whisper）需要 venv。
让 whisper-cli 产出词级时间戳在技术上可行（`-ml 1 -sow` / `-dtw`），但精度是否足以驱动配音
需要实验验证，不应与界面收敛绑定成败。记为待验证候选。

## Related Documents

- [CONTEXT.md](../../CONTEXT.md)
- [ADR-0005](./0005-commands-split-by-deliverable.md)
- [USAGE.md](../USAGE.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
