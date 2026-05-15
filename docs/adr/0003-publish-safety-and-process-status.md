# ADR-0003: 发布安全与每视频状态契约

- **Status**: Accepted
- **Date**: 2026-05-16
- **Deciders**: 项目负责人
- **Tags**: publish, safety, pipeline, process-status

## Context

yt2x 的流水线最终可以真实发布到 X。发布行为一旦执行，就会产生外部副作用，不能像本地文件生成一样简单回滚。

同时，流水线包含多个长耗时阶段：

- `acquire`
- `notes`
- `article`
- `publish`

这些阶段可能被分步执行，也可能通过 `pipeline` 串起来执行，还可能在失败后续跑。因此项目需要一个明确、稳定、可恢复的状态契约。

历史上曾考虑过根级批次状态文件，但这会和每个视频目录内的状态文件形成双状态源，容易出现漂移。

## Decision

### 1. 真实发布必须显式 opt-in

`pipeline` 中的发布阶段必须区分 preview 和真实发布：

- `--publish skip`：不进入发布阶段。
- `--publish review`：只生成发布预览，不调用 X API。
- `--publish auto`：真实发布，需要本地已有有效 X OAuth 凭证。

默认或 review 语义不得静默触发真实发帖。真实发帖必须由用户通过 `--publish auto` 或单独的 `yt2x publish` 命令明确触发。

### 2. dry-run / review 也要写状态

发布预览不是无状态操作。dry-run / review 成功时必须：

- 写入 `files/articles/<videoId>/publish-preview.json`。
- 更新 `<outDir>/<videoId>/process-status.json` 中的 `steps.publish`。
- 将 `steps.publish.status` 置为 `done`。
- 将 `steps.publish.resultFile` 指向 `publish-preview.json`。

这样 `pipeline --continue-from`、人工排障和 Agent 协作都能看到明确的 publish 阶段结果。

### 3. 每视频 `process-status.json` 是唯一步骤状态源

每个视频目录下的 `process-status.json` 是四阶段状态的唯一真理：

```text
<outDir>/<videoId>/process-status.json
```

根级 `pipeline-state.json` 不再读写，也不作为恢复来源。

批次队列由 `<outDir>` 下的视频子目录推断：目录中存在 `metadata.json` 或 `process-status.json` 即视为一个视频，按目录名的字典序处理。

### 4. 状态写入必须可恢复

状态写入由 `process-status-store` 统一处理：

- 写入前获取文件锁。
- 更新 `process-status.journal.ndjson`。
- 原子写入 `process-status.json`。
- 读取时合并主 JSON 与 journal。

调用方不应手写状态 JSON，也不应绕过 `patchProcessStatus` / `patchStepRunning` / `markStepDone` / `markStepFailed`。

### 5. `--video-id` 是安全目录名，不是路径

发布命令中的 `--video-id` 只接受字母、数字、连字符和下划线。路径输入必须被拒绝。

需要指定非默认文章目录时，应使用显式路径参数，例如 `--article-dir`，而不是把路径塞进 `--video-id`。

## Consequences

### Positive

- 防止 `pipeline --publish review` 等用户以为安全的命令真实发帖。
- 发布预览、真实发布和失败状态在磁盘上都有统一记录。
- 续跑逻辑无需同时协调根级状态和每视频状态。
- Agent 和人工排障都能通过同一套数据契约判断进度。
- `videoId` 不再承担路径语义，降低路径遍历风险。

### Negative

- `review` 当前是“生成预览并写状态”，不是交互式人工确认。未来若要增加交互确认，需要在不破坏本 ADR 的前提下扩展。
- 批次队列依赖输出目录扫描；如果用户手动放入含 `metadata.json` 或 `process-status.json` 的目录，它会被纳入队列。
- dry-run / review 会写磁盘产物，不能被视为完全无副作用。

## Alternatives Considered

### 1. `review` 直接真实发布前询问确认

拒绝。CLI 交互式确认在自动化、CI、Agent 执行场景下不稳定。当前选择让 `review` 始终只预览，真实发布通过 `auto` 明确 opt-in。

### 2. dry-run 不写状态

拒绝。这样 `process-status.json` 可能停留在旧失败、旧成功或 pending 状态，导致续跑和排障误判。

### 3. 保留根级 `pipeline-state.json`

拒绝。双状态源会带来漂移。每视频目录已经拥有足够信息，批次队列可以通过扫描目录稳定恢复。

### 4. 允许 `--video-id` 接受路径

拒绝。`videoId` 和路径语义混用会扩大安全边界。路径需求应由 `--article-dir` 这类显式参数承载。

## Related Documents

- [DATA-CONTRACTS.md](../DATA-CONTRACTS.md)
- [USAGE.md](../USAGE.md)
- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [ROADMAP.md](../ROADMAP.md)
