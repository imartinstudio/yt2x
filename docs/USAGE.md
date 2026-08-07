# yt2x 使用说明

面向本仓库开发者的日常命令与环境约定。架构总览见 [ARCHITECTURE.md](./ARCHITECTURE.md)，字段与状态契约见 [DATA-CONTRACTS.md](./DATA-CONTRACTS.md)。

## 环境要求

- **Node.js**：≥ 22（见根目录 `package.json` 的 `engines`）
- **包管理**：`pnpm` 9.x（`packageManager` 字段）
- **采集阶段（`yt2x video` 默认）**：系统需安装 **`yt-dlp`**、**`ffmpeg`**（Node 采集实现，见 `@yt2x/adapters-node` `src/acquire/`），并按需配置浏览器 cookies 等（见 `yt2x video --help`）
- **硬字幕检测 / 烧录辅助（Python）**：需要 Python 3 + **Pillow**（`detect-burned-subs.py` 与烧录测量脚本）。安装：`python3 -m pip install -r requirements.txt`
- **可选重型依赖（Python）**：见下方「可选 Python 依赖」。它们**刻意不在 `requirements.txt` 里**——装上会引入数 GB 的 torch，而只跑主链路的人用不到

### 可选 Python 依赖

只有走特定链路时才需要，各自独立安装：

| 依赖             | 什么时候需要                                             | 装法                                              |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `demucs`         | `yt2x dub` / `yt2x video --deliver dubbed`（分离背景音） | `pip install demucs`（会带上 torch / torchaudio） |
| `faster-whisper` | 本地词级转写（配音链路的输入）                           | `pip install faster-whisper`                      |

推荐装进独立 venv，避免把 torch 塞进基础环境：

```bash
python3 -m venv .venv-demucs
.venv-demucs/bin/pip install demucs faster-whisper
```

按上面的方式装进 `.venv-demucs` 的话，yt2x 会自动探测到它，不需要每次都传 `--python-path`。只有 demucs 装在候选列表之外的非常规路径时，才需要手动指过去：

```bash
pnpm yt2x dub --video-id <videoId> --python-path /path/to/your/python3
```

配音链路在**任何计费调用之前**先探测 demucs，缺了直接失败并提示上面这条命令——不会静默降级交出一个背景音被抹掉的成片。

## 安装

```bash
git clone <repo-url> yt2x && cd yt2x
pnpm install
```

开发时通过 **`pnpm yt2x`** 调用 CLI（等价于 `tsx packages/cli/src/index.ts`）。**`pnpm install` 后请执行 `pnpm run build`**（或 **`pnpm run rebuild`**）生成各 workspace 包的 **`dist/`**（`@yt2x/*` 包入口指向 `dist`）。若 `dist` 异常，先 **`pnpm run clean`** 再 build（会清除各包 **`.tsbuildinfo`**）。

## 常用命令

| 命令                        | 作用                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm yt2x --help`          | 列出所有子命令                                                                                                                                    |
| `pnpm yt2x video …`         | 交付**一个**视频产物：下载 → 转写 → 字幕 → 配音，选一个 `--deliver` 档位；`--search "词:2"` 搜前 2 条；`--search-sort views` 按播放量降序后再取 N |
| `pnpm yt2x text …`          | 从已采集视频交付**一个**文本产物：结构化笔记 → 长文 / 串推 / 短帖（`--video-id` 必填）                                                            |
| `pnpm yt2x notes …`         | 生成结构化笔记（native LLM；`--video-id` 或 `--all`）                                                                                             |
| `pnpm yt2x article …`       | 生成长文、串推或短帖（`files/articles/<videoId>/`）                                                                                               |
| `pnpm yt2x wechat-format …` | 将 `article.md` 通过内置 formatter 生成公众号排版 HTML / 预览页                                                                                   |
| `pnpm yt2x publish …`       | 发布到 X（OAuth 2.0 + v2）                                                                                                                        |
| `pnpm yt2x auth …`          | OAuth 2.0 PKCE 登录 / 登出 / 状态                                                                                                                 |
| `pnpm yt2x dub …`           | 生成中文配音成片：切分话语单元 → 带时长预算翻译 → 合成 → 协商时长 → 门禁 → 双语烧录一次                                                           |
| `pnpm yt2x dub-replay …`    | 从上一次 `dub` 留下的产物重放协商与字幕生成并打印指标；纯计算、秒级，用于调切分与协商参数                                                         |
| `pnpm yt2x watermark …`     | 只叠加左上角署名水印，不烧字幕；视频轨重编码，音轨 `-c:a copy`                                                                                    |
| `pnpm yt2x llm …`           | LLM 连通性诊断                                                                                                                                    |
| `pnpm run ci`               | typecheck + lint + format:check + test                                                                                                            |

`dub-replay` 只读产物、不写盘、不改变 `dub` 的行为，也不调 LLM / 合成 / 人声分离 / 烧录，因此
在真实素材上一两秒就能跑完。它**刻意没有时间窗参数**：短窗正是漏测的来源，重放始终覆盖产物
里的全部话语单元。`--preferred-rate-min` / `--stretch-max-occupancy` 用于反事实对比不同协商参数
对句间静默的影响；注意它算出的时间是协商阶段的**预估**，适合横向比较，绝对值以真实跑为准。

需要制作试听成片时，`dub` 也接受 `--preferred-rate-min <n>`，只覆盖本次时长协商，不改变默认值（当前默认 `0.85`）。
两次运行使用同一视频 `article` 目录下不同的 `--output-path`，这样会保留两份绝对路径不同的成片，同时复用同一份配音稿、
自然语速时长报告和其余中间产物：

```bash
pnpm yt2x dub \
  --video-id <videoId> \
  --preferred-rate-min 0.95 \
  --output-path ./files/articles/<videoId>/video/full.zh-dubbed-rate-095.mp4
pnpm yt2x dub \
  --video-id <videoId> \
  --preferred-rate-min 0.85 \
  --output-path ./files/articles/<videoId>/video/full.zh-dubbed-rate-085.mp4
```

请按顺序运行且不要加 `--force`；`--force` 会重新生成脚本和自然语速音频，使比较不再只改变协商地板。
每个成片旁还会写入同名的 `.audition.json`，记录语速地板、协商摘要和两道门结果；输出文件名不同只是为了避免覆盖，不是试听变量。默认语速下限只能在人耳确认试听代价后再调整——当前的 `0.85` 就是按这个流程比对 `0.95` 之后定的。

`yt2x video` / `yt2x text` 都不含发布阶段——发布永远是单独一步：`yt2x publish`。`publish` 不带
`--dry-run` 时会对 `x-thread` / `x-short` / `x-thread-short` 发起**真实** X API 调用；只想预览就显式传
**`--dry-run`**。`article` 目标没有公开发布 API，本身就只能预览或走浏览器草稿通道。详见下文「X 发布」。

## CLI 参数说明

所有命令都可以先用 `--help` 查看当前实现支持的参数，例如：

```bash
pnpm yt2x video --help
pnpm yt2x text --help
pnpm yt2x publish --help
```

### 视频来源参数

`video` 至少需要一种视频来源（`--urls` / `--url-file` / `--search`），或改用 `--video-id` 复用已采集素材；`text` / `notes` / `article` / `publish` 通常使用 `--video-id`、`--all` 或已有目录。

| 参数                  | 适用命令                                                                | 说明                                                             |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `--urls <url...>`     | `video`、通用来源参数                                                   | 一个或多个 YouTube URL，空格分隔。                               |
| `--url-file <path>`   | `video`、通用来源参数                                                   | 文本文件，每行一个 URL。                                         |
| `--search <query>`    | `video`、通用来源参数                                                   | 用 `yt-dlp ytsearch` 搜索；支持 `"关键词:N"` 取前 N 条。         |
| `--search-sort views` | `video`、通用来源参数                                                   | 配合 `--search` 使用，按播放量降序后再取 N；当前仅支持 `views`。 |
| `--video-id <id...>`  | `video`（复用已采集素材，跳过下载）、`text`（必填）、`notes`、`article` | 处理一个或多个视频 ID；也可传绝对路径到视频目录。                |
| `--video-id <id>`     | `publish`                                                               | 在 `--article-out-dir` 下查找对应文章目录。                      |
| `--all`               | `notes`、`article`                                                      | 批量处理所有符合条件的视频目录。                                 |
| `--out-dir <path>`    | `video`、`text`、`notes`、`article` 等                                  | 采集和笔记根目录，默认 `files/downloads`。                       |

YouTube URL 用引号包住即可，不要在引号内转义 `?` 或 `=`。正确示例：

```bash
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver none
```

错误示例：

```bash
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver none
```

### 采集参数

这些参数适用于 `yt2x video` 的下载 / 采集阶段。

| 参数                            | 默认值           | 说明                                                                                                         |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `--keyframes <n>`               | `0`              | 提取场景关键帧数量；`0` 表示跳过关键帧。需要 `ffmpeg`。                                                      |
| `--jobs <n>`                    | `3`              | 并发采集任务数。                                                                                             |
| `--sub-langs <lang>`            | 自动             | 手动字幕语言覆盖值，会传给 `yt-dlp --sub-langs`，例如 `en`、`zh-Hans`、`en,zh.*`。                           |
| `--scene-threshold <n>`         | `0.35`           | 场景检测阈值；值越低通常越容易切出更多关键帧。                                                               |
| `--scene-min-gap <n>`           | `12`             | 关键帧最小间隔秒数。                                                                                         |
| `--max-words <n>`               | `900`            | `chunks.md` 每个转写分块的最大词数。                                                                         |
| `--cookies-from-browser <name>` | 无               | 把浏览器登录态 cookies 传给 `yt-dlp --cookies-from-browser`。详见下方“人机验证 / 登录态”。                   |
| `--proxy <url>`                 | 无               | 把代理传给 `yt-dlp --proxy`，例如 `http://127.0.0.1:1082`。                                                  |
| `--no-download-video`           | 关闭（默认下载） | 跳过默认的完整 MP4 视频下载（默认格式限制为 720p 上限）。                                                    |
| `--video-only`                  | 关闭             | 仅 `video` 支持；配合 `--deliver none` 使用，只下载视频，跳过字幕、转写、截图和后续文档生成。                |
| `--video-start <time>`          | 无               | 手动指定视频片段开始时间，支持秒数、`MM:SS` 或 `HH:MM:SS`；可配合 `--video-end` 或 `--video-duration` 使用。 |
| `--video-end <time>`            | 无               | 手动指定视频片段结束时间；与 `--video-start` 同时使用时下载指定片段。                                        |
| `--video-duration <seconds>`    | `30`             | 与 `--video-start` 组合表示从开始时间下载 N 秒，当前最大 600 秒。                                            |
| `--error-strategy stop\|skip`   | `stop`           | 批量处理多个视频时遇到失败是立刻停止，还是跳过失败项继续处理后续视频。                                       |

视频下载示例：

```bash
# 默认下载完整 MP4 视频（720p 上限），不产出字幕
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver none

# 跳过默认视频下载，只采集 metadata / 字幕 / 转写
pnpm yt2x video --urls "<YOUTUBE_URL>" --no-download-video --deliver none

# 手动下载指定时间段
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --video-start 00:03:10 \
  --video-end 00:03:40 \
  --deliver none

# 从指定开始时间下载 5 秒，只要视频不要字幕/转写
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --video-only \
  --video-start 00:07:13 \
  --video-duration 5 \
  --deliver none

# 只下载完整视频，不生成字幕和转写
pnpm yt2x video --urls "<YOUTUBE_URL>" --video-only --deliver none
```

下载产物位于 `files/downloads/<videoId>/video/`。默认完整视频写入 `video/full.mp4`，手动时间段写入 `video/clip.mp4`，两者都会重写 `video/clip-manifest.json`。普通采集模式下，视频下载失败只记录 warning，不影响 `metadata.json`、`chunks.md` 和 `timestamped-cues.md` 的主链路；`--video-only` 模式下，视频就是主目标，下载失败会导致下载阶段（`process-status.json` 里的 `acquire` 步骤）失败。

重新下载视频时，yt2x 会清理旧的 `video/full.*` / `video/clip.*` 并让 `yt-dlp` 覆盖输出，避免 `clip-manifest.json` 已更新但视频文件仍是旧文件。用户侧不需要传 `--force-overwrites`；这是 yt2x 内部传给 `yt-dlp` 的实现细节。

### 语义双语字幕

双语字幕只有语义流程：先把连续英文 cue 翻译并组织成完整中文句，再用最终渲染器测量
80% 画面宽度；只有 `hard` 组会在安全的原文语义断点上做第二轮定向重排。没有关闭
语义处理或退回逐 cue 交付的入口。

```bash
# 生成文章侧语义双语 SRT
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver bilingual-srt

# 通过全部交付门后生成 ASS 和双语烧录视频
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver bilingual-burned
```

双语模式在 `files/articles/<videoId>/video/` 写入 `full.en.srt`、
`full.zh.srt`、`full.bilingual.srt` 和 `full.bilingual.semantic.json`；ASS 或烧录模式
还会按需生成 `full.bilingual.ass`、`full.bilingual-burned.mp4`。下载目录只作为字幕和
视频源读取，不会创建或修改二创字幕、ASS、manifest、烧录视频或本地转写临时文件。
双语模式找不到已下载的源语言 SRT/VTT 时直接失败，不会在下载目录启动本地 ASR。

Lexend Deca 可用时用于原文；缺失时依次回退到 PingFang SC、Hiragino Sans GB、
STHeiti，并把实际字体写入语义 manifest。翻译、覆盖、时间对齐、语义断句、布局或
文件 SHA 任一校验失败时，命令以非零状态退出并在文章目录保留
`status: "failed"` 的机器可读报告；不会生成或复用烧录 MP4。只有 manifest 为
`semantic-bilingual/ready`、四阶段全部完成且质量门通过时才允许烧录。

`--force` 是 yt2x 的阶段级覆盖语义：`video`、`text`（notes / article）都支持，用于覆盖已有阶段产物。`yt2x video --video-only` 变更 `--video-start` / `--video-end` / `--video-duration` 时会按新范围重新下载，不需要 `--force`。

#### yt2x video 中的视频下载组合

`yt2x video` 默认在下载阶段顺带下载完整视频，也支持 `--video-only`（只下载视频片段，跳过字幕 / 转写，见上文「采集参数」）。需要跳过视频下载本身时使用 `--no-download-video`。笔记 / 文章生成是单独一步，用 `yt2x text --video-id <id> ...` 接着跑；`yt2x video` 完成后会在日志里打印可以直接复制的 `yt2x text` 命令。

```bash
# 下载完整 MP4 视频（720p 上限），再生成笔记和文章
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver none
pnpm yt2x text --video-id <videoId> --notes auto --article auto

# 跳过默认视频下载，只保留 metadata / 字幕 / 转写，再生成笔记但跳过文章
pnpm yt2x video --urls "<YOUTUBE_URL>" --no-download-video --deliver none
pnpm yt2x text --video-id <videoId> --notes auto --article skip

# 下载手动指定时间段，同时继续生成笔记和文章
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --video-start 00:07:13 \
  --video-end 00:07:30 \
  --deliver none
pnpm yt2x text --video-id <videoId> --notes auto --article auto

# 从指定开始时间下载 5 秒，同时只跑到 notes
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --video-start 00:07:13 \
  --video-duration 5 \
  --deliver none
pnpm yt2x text --video-id <videoId> --notes auto --article skip
```

`yt2x video` 下载视频不会把视频转写成文本。后续 `yt2x text` 仍需要下载阶段生成的 `chunks.md` 和 `timestamped-cues.md`。如果 YouTube 没有手动字幕或自动字幕，`yt2x video --deliver none`（不带 `--video-only`）会失败；此时可先用 `yt2x video --video-only --deliver none` 只验证视频下载。

#### YouTube 人机验证 / 登录态

如果采集失败并出现 YouTube 要求登录、确认不是机器人、人机验证、年龄限制、区域限制，或 `yt-dlp did not write .info.json (check cookies / network)` 之类错误，优先使用浏览器 cookies：

```bash
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome \
  --deliver none
```

涉及笔记 / 文章生成时同理，先用 `yt2x video` 完成采集，再用 `yt2x text` 生成笔记 / 文章：

```bash
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome \
  --deliver none
pnpm yt2x text --video-id <videoId> --notes auto --article auto
```

`--cookies-from-browser` 的值会原样传给 `yt-dlp`。常见值包括 `chrome`、`firefox`、`edge`、`brave`、`chromium`、`safari` 等；如果你使用浏览器 profile，也可以使用 `yt-dlp` 支持的扩展格式。建议先在目标浏览器里登录 YouTube，并确认可以正常打开该视频，再运行 yt2x。macOS 上读取浏览器 cookies 时可能会弹出钥匙串授权。

如果网络环境还需要代理，可以同时传：

```bash
pnpm yt2x video \
  --urls "<YOUTUBE_URL>" \
  --cookies-from-browser chrome \
  --proxy "http://127.0.0.1:1082" \
  --deliver none
```

注意：这些 cookies 只从本机浏览器读取并传给本机 `yt-dlp` 进程；不要把浏览器 cookies、导出的 cookie 文件、API key 或 OAuth token 提交到仓库。

### 配音（dub）

`yt2x dub --video-id <videoId>` 生成中文配音成片 `full.zh-dubbed.mp4`：把本地词级转写切成话语单元、
翻译并按时长预算改写、用 edge-tts（默认）或 ElevenLabs 合成、与 Demucs 分离出的背景音混音、
按需协商时长，最后统一烧录双语硬字幕。完整参数见 `pnpm yt2x dub --help`。

成片音轨是三路混音：中文配音（音量 1.0）、背景音（0.7）、以及压低垫在下面的原声（默认
0.2）——保留原声是为了让观众仍能隐约听见讲者本人的语气与情绪，不是把原声整条替换掉。
不同素材适合不同的垫底强度（访谈类可能想调高，纯讲解类可能想调低甚至关掉），用
`--original-voice-volume <value>` 覆盖默认值：

```bash
# 提高原声存在感（访谈、对谈类素材）
pnpm yt2x dub --video-id <videoId> --original-voice-volume 0.4

# 关闭原声垫底，只保留中文配音 + 背景音（自动退回两路混音，不引入静音输入）
pnpm yt2x dub --video-id <videoId> --original-voice-volume 0
```

不传 `--original-voice-volume` 时行为与此前完全一致（垫底音量 0.2）。

`--preferred-rate-min <n>` 覆盖本次协商的反向放慢地板，**默认 `0.85`**——即允许把语速放慢到
原速的 85% 去填充较长的句间空档。这个值是试听 `0.85` 与 `0.95` 两版成片后定下的：`0.95` 留下
的静默明显偏长（全片总静默 77.1s，5.0% 的句间空档超过 2 秒），`0.85` 降到 40.0s / 0.8%，慢下来
的语速听感上可接受。调低还能进一步压静默，但会开始像在拖。改这个值请配合 `--output-path`
保存两份成片实际试听，不要只看数字。

### 水印

左上角署名水印是一张 PNG（`gen-watermark.py` 渲染，需要基础环境的 Pillow），由 ffmpeg
叠在 `overlay=24:16`，黑色 24% 不透明度——远看不打扰，凑近才看得清。两行分别是
「视频：@频道」和「字幕：@署名」。频道 handle 自动从 `metadata.json` 的 `uploader_id` 读。

水印在两个地方出现：

- **跟着烧录走**（推荐）：`yt2x video --deliver zh-burned|bilingual-burned|dubbed` 和 `yt2x dub`
  都会在自己那次烧录里一并叠上，只编码一次。
- **单独叠加**：`yt2x watermark`，用于给已有成片补水印，不烧字幕。

```bash
# 用 videoId：取 downloads/<id>/video/full.mp4，频道署名自动读
pnpm yt2x watermark --video-id <videoId>

# 任意文件；路径形如 <root>/<videoId>/video/<file> 时会自动反推 videoId 拿频道署名
pnpm yt2x watermark --input files/articles/<videoId>/video/full.zh-dubbed.mp4
```

默认输出是源文件旁加 `.watermarked` 后缀，已存在则跳过，`--force` 覆盖。这条路只重编码
视频轨，音轨 `-c:a copy`，所以给配音成片补水印不会二次损伤音质；但它终究是第二次视频编码，
画质略降——能在烧录时一并叠上就不要走这条路。

改署名用 `--watermark-subtitler <handle>`（`dub`、`watermark` 都支持；`yt2x video` 目前没有
暴露这个 flag，字幕烧录跟着 `yt2x video` 走时用默认署名），传空字符串则不写「字幕：」那一行。
`watermark` 还接受 `--watermark-video <handle>` 覆盖频道署名。

### video / text 通用控制参数

`yt2x video` 是单一 `--deliver` 档位，没有 `pipeline` 那种「阶段」概念（不存在 `--acquire auto|review|skip`
之类的 flag）；`yt2x text` 保留了 `--notes` / `--article` 两个子阶段的 `auto|review|skip` 模式，但目前
`auto` 与 `review` 行为一致（都会执行该阶段，没有交互式确认提示）——只有 `skip` 会真正跳过该阶段。

| 参数                           | 适用命令        | 默认值 | 说明                                                                                       |
| ------------------------------ | --------------- | ------ | ------------------------------------------------------------------------------------------ |
| `--notes auto\|review\|skip`   | `text`          | `auto` | 结构化笔记阶段；`auto`/`review` 当前效果相同。                                             |
| `--article auto\|review\|skip` | `text`          | `auto` | 内容生成阶段；默认生成 `article.md`，可用 `--targets` 调整；`auto`/`review` 当前效果相同。 |
| `--force`                      | `video`、`text` | 关闭   | 覆盖已有阶段产物（下载 artifact、`structured-notes.md`、`article.md` 等）。                |
| `--error-strategy stop\|skip`  | `video`、`text` | `stop` | 处理多个视频时遇到失败是立刻停止，还是跳过失败项继续处理后续视频。                         |
| `--verbose`                    | `video`、`text` | 关闭   | 输出更详细日志。                                                                           |

「续跑一批失败/中断的任务」不再由单一 `--continue-from` flag 完成，见下文「续跑与批次队列」。

### LLM 参数

`notes`、`article`、`text` 会使用 LLM；`video` 在交付档位需要中文字幕翻译时（`zh-srt` 及以上）也会使用 LLM。

| 参数                   | 说明                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `--llm-provider <id>`  | `openai`、`anthropic`、`deepseek`、`moonshot`；默认读环境变量。 |
| `--llm-model <name>`   | 覆盖 provider 默认模型。                                        |
| `--llm-base-url <url>` | 覆盖 provider 默认 Base URL，适合 OpenAI 兼容网关或代理。       |

可先用下面命令验证 LLM 配置：

```bash
pnpm yt2x llm ping --provider openai
```

### 文章与发布参数

| 参数                           | 适用命令                              | 说明                                                                                                   |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--platform <name>`            | `article`、`text`                     | 目标平台；当前主要支持 `x`。                                                                           |
| `--rewrite-mode rules\|llm`    | `text`                                | 长文标题 / 内容改写策略；默认 `rules`。                                                                |
| `--targets <targets>`          | `article`、`text`                     | 生成目标，支持 `article`、`x-thread`、`x-short`、`all` 和逗号分隔组合；`x-longform` 仅作旧别名。       |
| `--platform-targets <targets>` | `article`、`text`                     | 多平台适配目标，支持 `xiaohongshu`、`wechat`、`bilibili`、`all-platforms` 和逗号分隔组合；默认不生成。 |
| `--article-out-dir <path>`     | `article`、`text`、`video`、`publish` | 文章 / 烧录视频输出根目录，默认 `files/articles`。                                                     |
| `--article-dir <path>`         | `publish`                             | 显式指定文章目录，跳过按 `--video-id` 自动发现。                                                       |
| `--profile <name>`             | `publish`                             | X OAuth 凭证 profile，默认 `default`。                                                                 |
| `--dry-run`                    | `publish`                             | 只生成 / 打印发布预览，不调用 X API。                                                                  |
| `--target <target>`            | `publish`                             | 发布目标，支持 `article`、`x-thread`、`x-short`、`x-thread-short`；`article` 只预览，不调用 X API。    |
| `--thread-source <source>`     | `publish`                             | `x-thread` 来源：`generated` 使用 `x-thread.md`，`article` 拆 `article.md`，`auto` 优先生成串推。      |
| `--thread`                     | `publish`                             | 兼容开关，等价于 `--target x-thread`。                                                                 |
| `--publish-max-chars <n>`      | `publish`                             | `x-thread` 单条字数上限，默认 500；`x-short` 不设置固定字数上限。                                      |
| `--max-chars <n>`              | `publish`、`text`                     | `publish` 中是 `--publish-max-chars` 别名；`text` 中是文章阶段字数提示（legacy，默认 280）。           |
| `--max-tweets <n>`             | `publish`                             | thread 模式最大推文数，`x-thread` 默认 8，`x-thread-short` 默认 10，最大 10。                          |
| `--thread-delay <range>`       | `publish`                             | thread 每两条之间的等待秒数，默认 `20-30`；固定值如 `10`，`0` 表示不等待。                             |
| `--numbering`                  | `publish`                             | thread 模式下给每条推文加编号。                                                                        |
| `--continue-on-failure`        | `publish`                             | thread 发布时某条失败后继续尝试后续推文。                                                              |

`--publish-dry-run`（旧 `pipeline` 发布阶段 dry-run）已随 `pipeline` 一起消失，没有等价 flag——预览发布
现在统一用 `yt2x publish --dry-run`（见上表 `--dry-run` 行）。

## 目录约定

| 路径                         | 含义                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `files/downloads/<videoId>/` | 默认采集 + 笔记根目录（`--out-dir` 可改）                           |
| `files/articles/<videoId>/`  | **默认 article（native）** 内容输出（`--article-out-dir` 可改）     |
| `files/`                     | 本地大文件 / 临时产出（根 `.gitignore` 已忽略除 `.gitkeep` 外内容） |

## LLM 环境变量（native 路径）

在仓库根复制 **`.env.example` → `.env`** 并填写密钥；`pnpm yt2x` 启动时会自动加载仓库根（及当前工作目录）的 **`.env`**，且**不会**覆盖已在 shell 里导出的同名变量。

- **默认 provider**（省略 `--llm-provider` 时）：环境变量 **`YT2X_LLM_PROVIDER`** 或 **`YT2X_DEFAULT_LLM_PROVIDER`**，取值 `openai` | `anthropic` | `deepseek` | `moonshot`，或别名 **`gpt`** / **`claude`** / **`kimi`**（未设置时默认为 `openai`）。
- **OpenAI / GPT**：`OPENAI_API_KEY`（或 `OPENAI_KEY`、`GPT_API_KEY`）
- **Anthropic / Claude**：`ANTHROPIC_API_KEY`（或 `CLAUDE_API_KEY`、`CLAUDE_KEY`）
- **DeepSeek**：`DEEPSEEK_API_KEY`
- **Moonshot（Kimi）**：`MOONSHOT_API_KEY`

可选：`OPENAI_BASE_URL` 等覆盖默认 Base URL；CLI 支持 `--llm-provider` / `--llm-model` / `--llm-base-url`。

## X 发布（默认 native `publish`）

先完成 `yt2x auth login`，token 默认在 `~/.config/yt2x/credentials.json`。`publish` 使用 **`--article-out-dir`**（默认 **`./files/articles`**）。

采集在 **`packages/adapters-node/src/acquire/`**（Node + yt-dlp/ffmpeg）。`yt2x publish`
对 `x-thread`、`x-short` 和 `x-thread-short` 使用 OAuth 2.0 API；X Articles
没有公开发布 API，`article` 只能 dry-run 或显式走浏览器草稿通道。

发布命令只接受安全的视频目录名作为 **`--video-id`**（字母、数字、连字符、下划线），避免把路径误当成视频 ID。需要指定非默认内容目录时使用 **`--article-dir`**。

生成阶段可自由组合目标：

```bash
pnpm yt2x article --video-id <videoId> --targets article,x-thread,x-short
pnpm yt2x article --video-id <videoId> --targets article --platform-targets xiaohongshu,wechat,bilibili

# 从 URL 开始的完整流程：先采集，再一次性生成全部目标
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver none
pnpm yt2x text --video-id <videoId> --targets all

# 从 URL 开始，只生成长文并适配全部平台稿
pnpm yt2x video --urls "<YOUTUBE_URL>" --deliver none
pnpm yt2x text --video-id <videoId> --targets article --platform-targets all-platforms
```

`yt2x text` 不含发布阶段（不再有 `pipeline` 的 `--publish review` 联动预览）；需要预览发布内容时，
在内容生成之后单独运行 `yt2x publish --video-id <videoId> --target <target> --dry-run`（见下文各条
`publish` 示例）。

`--platform-targets` 从 `article.md` 适配生成平台稿。如果本次没有包含 `--targets article`，对应文章目录中必须已经存在 `article.md`。产物命名为 `xiaohongshu-article.md` / `xiaohongshu-metadata.json`、`wechat-article.md` / `wechat-metadata.json`、`bilibili-article.md` / `bilibili-metadata.json`。

公众号排版通过**内置 formatter**（`@yt2x/adapters-node` 的 `formatWechatArticle`）完成 HTML 渲染，无需外部 Python 脚本或额外 checkout。内置主题：`github`（默认）、`newspaper`、`minimal`。

已有 `article.md` 后执行排版：

```bash
pnpm yt2x wechat-format --video-id <videoId> --theme github
```

默认读取 `files/articles/<videoId>/article.md`，输出到 `files/articles/<videoId>/wechat-format/article/`，其中 `article.html` 用于复制到公众号编辑器，`preview.html` 用于本地预览。该命令只做本地排版，不推送公众号草稿箱。

发布阶段一次只发布一种目标：

```bash
pnpm yt2x publish --video-id <videoId> --target article --dry-run
pnpm yt2x publish --video-id <videoId> --target x-thread --thread-source generated --dry-run
pnpm yt2x publish --video-id <videoId> --target x-short --dry-run
pnpm yt2x publish --video-id <videoId> --target x-thread-short --dry-run
```

要把长文写入 X Articles 草稿箱，先准备 Playwright 浏览器，再用登录过 X Premium 的
persistent browser profile：

```bash
pnpm exec playwright install chromium
pnpm yt2x publish --video-id <videoId> --target article --browser-draft
```

首次运行时可用 `--browser-profile-dir <path>` 指定专用 profile 并在有头浏览器里完成
登录；`--x-subscription premium-plus` 会保留 Premium+ 可接受的深层标题和表格。
命令只填充草稿，不点击 X 的正式发布按钮。成功后 article 目录会新增
`article_for_x.md` 与 `publish-result.json`；原始 `article.md` 保持不变。

`article` 无 flag 的真实发布会直接失败，避免把长文误走 Tweet API；真实 API 发布覆盖
`x-thread`、`x-short` 和 `x-thread-short`。`x-thread-short` 会把 `x-short.md`
作为首推，再把 `x-thread.md` 中的内容按顺序作为回复发布；`x-short` /
`x-thread-short` 发布首推时会尽量附带 `images/cover.*` 封面图。真实发布
`x-thread` / `x-thread-short` 时，每两条推文之间默认随机等待 20-30 秒，可用
`--thread-delay` 配置。旧参数 **`--thread`** 保持兼容，等价于 **`--target x-thread`**。

`x-thread.md` 发布时用行首 `1/`、`2/`、`3/` 作为 tweet 边界，单条 tweet 内部的空行和纯文本结构会保留到同一条回复中。新生成规则要求 `x-thread.md` / `x-short.md` 不使用 Markdown 加粗、列表、代码块等格式；发布前转换 hook 仍兼容旧 Markdown 产物。

## 内容质量 warning

`yt2x article` / `pnpm yt2x text --article auto` 在生成 `article.md` / `x-short.md` / `x-thread.md` 之后会运行一组**纯函数**质量检查，命中任意规则时以 `warn` 级别日志输出，但**不会阻断**产物落盘。warning 来自 `@yt2x/core` 的 `checkArticleQuality` / `checkShortQuality` / `checkThreadQuality`，规则定义在 `docs/CONTENT-QUALITY-TASK.md`。

常见 warning code 与含义：

| Code                                              | 含义                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `article.title-not-bold`                          | H1 未写成 `# **标题**` 格式                                   |
| `article.lead-too-long`                           | 导语超过 120 字，移动端首屏会被截断                           |
| `article.no-sections`                             | 缺少 `## **小节标题**`，无法建立扫描节奏                      |
| `article.long-paragraph`                          | 出现 ≥250 字的超长段落，需要拆分                              |
| `article.too-many-consecutive-paragraphs`         | 连续 >2 个正文段落未插入列表 / 引用 / 代码块 / 图片等视觉锚点 |
| `article.missing-risk-section`                    | 主题命中高信任成本场景但缺少 `## **风险与适用边界**` 小节     |
| `article.missing-executable-asset`                | 文章没有 prompt / 模板 / 清单 / 步骤 / 决策树等可执行资产     |
| `article.summary-tone-hook`                       | 导语以「本视频介绍」「近年来」等摘要腔开头                    |
| `article.author-phrase`                           | 出现禁用词「视频作者」                                        |
| `short.list-out-of-range`                         | Short list item 不在 4–6 之间                                 |
| `short.no-executable-item`                        | Short 缺少至少 1 条可执行要点（命令、prompt、模板、检查项）   |
| `short.missing-risk-reminder`                     | 高信任主题 short 缺少独立风险提醒 list item                   |
| `short.summary-tone-hook` / `short.author-phrase` | 首句摘要腔 / 出现「视频作者」                                 |
| `thread.tweets-out-of-range`                      | tweet 数不在 6–10 条                                          |
| `thread.tweet-too-long`                           | 单条 tweet 超过 500 字符                                      |
| `thread.first-tweet-numbering`                    | 首推以 `1/` / `本视频` 等串推编号或摘要腔开头                 |
| `thread.first-tweet-summary-tone`                 | 首推首句命中摘要腔禁用词                                      |
| `thread.no-executable-tweet`                      | 整条 thread 缺少模板 / 清单 / 步骤 / 风险 tweet               |
| `thread.missing-risk-tweet`                       | 高信任主题缺少独立风险 / 边界 tweet                           |
| `thread.author-phrase`                            | 出现禁用词「视频作者」                                        |

处理建议：

- warning 仅作为「这条产物不符合 X 信息流内容产品规则」的提示，不会阻断你继续 publish。
- 如果对该次生成结果不满意，可以删除 `article.md` 等产物后用 `--force` 重跑；warning 命中越多越值得重生成。
- 高信任成本主题（外区账号、礼品卡、OAuth、cookies、自动发布等）建议处理掉所有 `missing-risk-*` warning 再发布，避免误导读者。

## 视觉建议产物 `visual-suggestions.json`

生成 `article` 目标时，如果文章中存在抽象框架、流程、对比、模板或风险类小节，会同时在 `files/articles/<videoId>/visual-suggestions.json` 写入一份「这篇 article 适合配什么样的图」的建议（仅当至少有 1 条建议时写入，否则跳过）。

文件结构示例：

```json
{
  "v": 1,
  "suggestions": [
    {
      "kind": "diagram",
      "target_section": "完整流程",
      "description": "建议在小节「完整流程」插入流程图：用节点 + 箭头表达「输入 → 处理 → 验证 → 输出」式步骤。",
      "priority": "high",
      "trigger": "流程"
    }
  ]
}
```

字段含义：

- `kind`：`ui-screenshot` / `diagram` / `comparison` / `template-card` / `none`。
- `target_section`：建议对应的 `##` 小节标题（去掉加粗符号）。
- `description`：人类可读的图片需求描述。
- `priority`：`high` / `medium` / `low`，建议越高越值得优先做图。
- `trigger`：命中该建议的关键词。

约束：

- 视觉建议只描述「应该生成什么图」，**不会**修改 `article.md` 正文，也不会写入虚构图片路径。
- 如果当前版本没有图表生成能力，可以把建议作为人工出图或对接图表渲染服务的输入。
- 没有命中任何视觉建议时不会写文件，目录保持干净。

## 文章封面选择规则

`writeNativeArticleBundle` 在复制封面到 `files/articles/<videoId>/images/cover.*` 时，按以下优先级选择源文件：

1. `youtube_cover.*`（YouTube 官方封面）
2. 任意非 `contact_sheet.*` 的截图（通常是关键帧）
3. `contact_sheet.*`（拼图缩略，最低优先级）

实现位于 `@yt2x/core` 的 `pickArticleCoverFromCandidates`，纯函数，单测覆盖。`contact_sheet.*` 仅在没有其他可用图片时才会被选中，避免拼图缩略图当默认封面。

## 续跑与批次队列

`yt2x video` / `yt2x text` 都**没有** `--continue-from` 或等价 flag——这是一处真实的能力缺口，不是
文档遗漏。旧版 `pipeline --continue-from` 会在 `--out-dir` 下扫描已有 `metadata.json` / `process-status.json`
的视频子目录，**不需要重新提供原始 URL 列表**就能恢复整批队列（按子目录名 `video_id` 字典序处理，
见 `listBatchVideosFromOutRoot`）。拆分后的 `video` / `text` 都要求显式传入来源（`--urls` /
`--url-file` / `--search`，或 `--video-id`），没有「不带来源参数、仅凭磁盘状态自动继续」的入口。

不过，只要你还留着原始来源，重新跑同一条命令是安全的（幂等），效果上等价于续跑：

- `yt2x video` 的下载阶段按视频逐个判断所需 artifact 是否已产出（`metadata.json`、`chunks.md`、
  `timestamped-cues.md`，或 `--video-only` 场景下的 `metadata.json` + `video/clip-manifest.json`），
  已完成的视频会直接跳过、不重新下载——见 `executeNativeAcquire` 里的 `shouldSkipAcquireForVideo`。
- `yt2x text` 的 `notes` / `article` 两个子阶段各自在产物已存在时跳过（`structured-notes.md`、
  `article.md` 等），逻辑分别在 `executeNativeNotes` / `executeNativeArticle`。
- 以上跳过行为都可以用 `--force` 强制覆盖重跑。

因此续跑一批失败或中断的任务，目前的做法是：保留原始 URL 列表（推荐用 `--url-file` 落盘，而不是
只敲在命令行历史里），用同一条 `yt2x video ... --deliver <tier>` 命令重新跑一遍——已完成的视频会被
自动跳过，只有失败或未完成的会真正重新处理；`yt2x text` 同理，用同一批 `--video-id` 重新跑。如果
原始 URL 列表已经丢失，可以用 `ls <out-dir>` 列出已有视频目录名，手动拼成 `--video-id` 列表传给
`yt2x video` / `yt2x text`，但这需要自己重建队列，不再有一个 flag 帮你自动完成。

## 与 Agent / Skill 的关系

跨平台可复制提示词和本地 Agent Skill 模板以 **`docs/AGENT-PROMPTS.md`** 为准；该文档不绑定单一客户端，可用于 Claude Code、Codex、Cursor 或其他支持用户级指令的 Agent。
