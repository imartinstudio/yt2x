# Visual content task

版本归属：v0.2

## 背景

yt2x 已支持在采集阶段通过 `--keyframes` 生成 `screenshots/scene_manifest.json`，但当前截图只作为笔记阶段的参考素材，尚未形成可控的内容配图链路。长文、串推、短文如果要加入截图、emoji 或更丰富编排，必须避免两类问题：

- LLM 描述或引用不存在的图片。
- 自动截图选到无信息量画面，例如主播人像位于屏幕中间、转场、模糊画面或重复界面。

本任务目标是建立“截图由采集阶段提供，LLM 只能选择，渲染/发布阶段执行”的可追踪闭环。

## 目标

新增可控视觉素材链路：

```text
acquire --keyframes
  -> screenshots/scene_manifest.json
  -> available_visuals
  -> article visual_plan
  -> article.md 图片引用
  -> thread/short visual_plan（后续发布阶段消费）
```

首个可交付版本优先支持 `x-longform`，后续再扩展到 `x-thread` 和 `x-short`。

## 非目标

- 不让 LLM 生成或想象截图。
- 不在没有真实图片文件时写“见图”“如下图”。
- 不默认给所有内容加 emoji。
- 不把视频里的主播居中口播画面作为优先配图。
- 不在 v0.2 MVP 中实现复杂视觉理解模型训练。

## 设计原则

- `scene_manifest.json` 是截图池的唯一来源；内容生成只能引用其中存在的 `visual_id`。
- 没有合适截图时，内容保持纯文本。
- 截图必须服务信息表达：配置界面、命令输出、验证结果、流程节点、对比画面优先。
- 主播位于屏幕中间的截图默认不选；如果当前时间点截图为居中人像，应向时间轴后方寻找最近的无人像或弱人像信息画面。
- emoji 只能作为语义锚点，不能作为装饰噪音。

## 产物约定

采集目录：

```text
files/downloads/<videoId>/screenshots/
  scene_01_00-01-23.jpg
  scene_manifest.json
  contact_sheet.jpg
```

建议扩展后的 `scene_manifest.json`：

```json
{
  "source": "<YOUTUBE_URL>",
  "method": "ffmpeg_scene_detection_stream",
  "frames": [
    {
      "id": "scene_003",
      "timestamp": "00:03:21",
      "seconds": 201,
      "file": "scene_03_00-03-21.jpg",
      "transcript_context": "引入 GitHub 规则集代替手写规则",
      "selection_reason": "scene_change",
      "visual_quality": {
        "blur": "low",
        "blur_score": 0.91,
        "has_text": true,
        "has_ui": true,
        "center_presenter": false,
        "usable_for_content": true
      }
    }
  ]
}
```

内容生成阶段传入 LLM 的 `available_visuals`：

```json
[
  {
    "visual_id": "scene_003",
    "path": "screenshots/scene_03_00-03-21.jpg",
    "timestamp": "00:03:21",
    "nearby_text": "引入 GitHub 规则集代替手写规则",
    "quality": {
      "blur": "low",
      "has_text": true,
      "has_ui": true,
      "center_presenter": false
    }
  }
]
```

长文输出建议增加：

```ts
type ArticleVisualPlanItem = {
  target: string;
  visual_id: string;
  caption: string;
  reason: string;
};
```

串推/短文先输出单独计划文件，避免 Markdown 和 X media upload 混在一起：

```text
x-thread-visuals.json
x-short-visual.json
```

## 主播人像过滤规则

关键帧截图选择必须加入以下规则：

```text
如果候选帧中心区域存在明显主播人像：
  1. 不直接选该帧作为内容截图；
  2. 沿时间轴向后查找最近的候选帧；
  3. 优先选择屏幕中间没有人像、且包含界面/文字/命令输出的截图；
  4. 如果后方连续候选都有人像，则允许回退到弱人像但内容主体清晰的画面；
  5. 如果仍无合适截图，则该内容节点不配图。
```

MVP 可先用保守规则实现：

- 在 manifest 中记录 `center_presenter: "unknown"`，人工或后续视觉检测补充。
- 生成阶段默认过滤 `center_presenter === true` 的截图。
- 如果一个内容节点只匹配到居中人像截图，则不插图。

后续增强：

- 用人脸/人体检测判断画面中心 40% 区域是否有人像。
- 对候选帧做向后窗口搜索，例如 `+3s`、`+6s`、`+12s`。
- 结合 OCR 或画面文字密度优先选择教程界面。

## 清晰度过滤规则

关键帧截图必须支持清晰度检查；如果当前环境暂时无法做可靠检查，也必须在使用阶段保守跳过风险图片。

```text
如果支持清晰度检测：
  1. 为每张候选帧计算 blur_score；
  2. 将明显模糊、运动拖影、文字不可读的截图标记为 blur: "high"；
  3. blur: "high" 的截图不得进入 available_visuals；
  4. blur: "medium" 只有在没有更清晰替代帧且内容价值很高时才允许使用；
  5. blur: "low" 才作为默认可用截图。

如果暂不支持清晰度检测：
  1. manifest 中记录 blur: "unknown"；
  2. 长文/串推/短文使用阶段默认不使用 blur: "unknown" 的截图；
  3. 只有用户显式允许或人工标记 usable_for_content: true 时才可使用。
```

MVP 可用简单算法实现：

- 用 ffmpeg / sharp / OpenCV 计算拉普拉斯方差或边缘清晰度分数。
- 对截图缩略图计算即可，不需要处理整段视频。
- 阈值先走保守默认，后续用 fixture 校准。

## 开发步骤

本功能必须按任务拆分推进。每个任务完成后，需要在本节把任务总览和任务内完成标记从 `[ ]` 改为 `[x]`，将状态改为“已完成”，并确保该任务的验收标准已经满足。

任务总览：

- [x] Task 1: Manifest schema and available visuals
- [x] Task 2: Keyframe quality and presenter filtering
- [x] Task 3: Longform visual plan
- [x] Task 4: Longform image rendering
- [x] Task 5: Thread and short visual plans
- [x] Task 6: Publish media support
- [x] Task 7: Emoji and layout policy
- [x] Task 8: Documentation and fixtures

### Task 1: Manifest schema and available visuals

状态：已完成

范围：

- 定义截图 manifest 的稳定字段：`id`、`timestamp`、`seconds`、`file`、`transcript_context`、`visual_quality`。
- 兼容现有 `frames[].file` / `frames[].timestamp` 格式。
- 增加从 `scene_manifest.json` 转换为 `available_visuals` 的纯函数。
- 过滤不存在文件、空文件、`blur: "high"`、默认 `blur: "unknown"`、居中主播人像和明显不可用条目。

验收：

- 有 schema / parser 单测覆盖新旧 manifest。
- `available_visuals` 中只包含真实存在、可引用且清晰度合格的截图。
- 无 manifest 时内容生成保持纯文本。

完成后标记：

- [x] Task 1 complete

### Task 2: Keyframe quality and presenter filtering

状态：已完成

范围：

- 在关键帧选择逻辑中加入质量字段：模糊、黑屏、重复、文字/界面迹象、中心主播人像。
- 新增“居中人像向后替换”策略：候选帧中心有人像时，向时间轴后方寻找最近的无人像内容截图。
- 新增“模糊截图向后替换”策略：候选帧模糊或文字不可读时，向时间轴后方寻找最近的清晰内容截图。
- 记录替换过程，例如 `selection_reason: "presenter_center_skipped; replaced_by_later_ui_frame"`。
- 记录清晰度检测结果，例如 `blur: "low" | "medium" | "high" | "unknown"` 和可选 `blur_score`。
- 保留人工审查友好的 `contact_sheet`。

验收：

- 单测覆盖：候选帧中心有人像时跳过并选择后方无人像帧。
- 单测覆盖：候选帧模糊时跳过并选择后方清晰帧。
- 单测覆盖：后方没有合适帧时不强行配图。
- manifest 能标记 `blur`、`center_presenter`、`usable_for_content` 和替换原因。

完成后标记：

- [x] Task 2 complete

### Task 3: Longform visual plan

状态：已完成

范围：

- 将 `available_visuals` 注入长文生成 prompt。
- 要求 LLM 只输出引用已有 `visual_id` 的 `visual_plan`。
- 明确禁止描述图片里没有的信息。
- 没有合适截图或只有模糊/未知清晰度截图时 `visual_plan` 为空。

验收：

- prompt 单测覆盖 `available_visuals`、禁止幻觉、无图回退。
- adapter 解析 `visual_plan` 并拒绝不存在的 `visual_id`。
- adapter 拒绝引用模糊、未知清晰度或已过滤的 `visual_id`。
- 只实现长文，不影响 `x-thread` / `x-short` 当前输出。

完成后标记：

- [x] Task 3 complete

### Task 4: Longform image rendering

状态：已完成

范围：

- 将选中的图片复制到 `files/articles/<videoId>/images/`。
- 在 `article.md` 合适位置插入 Markdown 图片引用。
- caption 使用 LLM 输出，但必须与 `available_visuals` 上下文一致。

验收：

- 图片引用使用 article 目录内相对路径。
- 图片文件缺失时不写坏链接。
- 图片清晰度不合格或清晰度未知时不写图片引用。
- 生成结果可被 publish preview 正常读取。

完成后标记：

- [x] Task 4 complete

### Task 5: Thread and short visual plans

状态：已完成

范围：

- `x-thread` 输出 `x-thread-visuals.json`，记录每张图对应 tweet index。
- `x-short` 输出 `x-short-visual.json`，默认为空，只有截图显著增强可信度时选择 1 张。
- 不在 `x-thread.md` / `x-short.md` 里写 Markdown 图片。

验收：

- thread 最多选择 1–3 张图。
- short 最多选择 1 张图。
- 只引用 manifest 中存在、清晰度合格且未被过滤的截图。

完成后标记：

- [x] Task 5 complete

### Task 6: Publish media support

状态：已完成

范围：

- publish 阶段读取 `x-thread-visuals.json` / `x-short-visual.json`。
- 上传对应图片，发帖时带 media id。
- dry-run 预览显示每条 tweet / short 是否附图。

验收：

- dry-run 不上传媒体，只显示图片路径和目标 tweet。
- auto publish 上传失败时给出清晰错误，不发出缺图内容。
- 不影响纯文本发布路径。

完成后标记：

- [x] Task 6 complete

### Task 7: Emoji and layout policy

状态：已完成

范围：

- 定义长文、串推、短文的 emoji 策略。
- 长文默认不用 emoji，只允许风险/验证/步骤类语义标记。
- 串推每条最多 0–1 个语义 emoji。
- 短文默认纯文本，只有收益/验证/风险需要时允许 0–1 个 emoji。

验收：

- prompt 中明确 emoji 是可选语义锚点，不是装饰。
- 单测覆盖不会要求所有段落强制 emoji。

完成后标记：

- [x] Task 7 complete

### Task 8: Documentation and fixtures

状态：已完成

范围：

- 更新 README / USAGE / DATA-CONTRACTS 中截图 manifest、visual plan 和发布预览说明。
- 增加测试 fixture：无截图、有 UI 截图、有居中主播人像、有模糊截图、有替换帧。
- 记录 v0.2 MVP 与后续增强边界。

验收：

- 文档示例中的 YouTube URL / videoId 使用占位符。
- fixture 不包含真实视频 ID 或下载产物。
- `pnpm run ci` 通过。

完成后标记：

- [x] Task 8 complete
