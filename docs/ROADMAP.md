# yt2x Roadmap

本文件只记录当前仍有行动价值的路线图。历史 PR 验收稿和旧重构蓝图已从仓库文档中删除；当前完成度快照见 [REFACTOR-STATUS.md](./REFACTOR-STATUS.md)。

## 当前阶段

yt2x 处于 v0.1 开源前打磨期：

- CLI first。
- 全阶段 native：`acquire`、`notes`、`article`、`publish`、`pipeline`。
- npm 包仍保持 `private: true`，公开发布放在最后。
- 默认使用本地 clone + `pnpm yt2x`。

## v0.1 发布前

必须完成：

- GitHub 仓库和 Actions 保持绿色。
- `pnpm run ci:full` 通过。
- README / CONTRIBUTING / LICENSE / NOTICE / docs 入口保持一致。
- 手测至少一条真实视频：采集、笔记、文章、发布预览。
- 确认 `pipeline --publish review` 只预览，`--publish auto` 才真实发帖。
- npm 发布前检查 tarball、包入口、版本号、`workspace:*` 依赖替换。

可选完成：

- README 演示 GIF 或短视频。
- 增加一份发版 checklist issue template。

## v0.2 候选方向

以下方向尚未承诺排期：

- Chrome 扩展或浏览器侧工作流。
- LLM streaming 输出。
- 本地模型 / Ollama provider。
- 更细的成本统计与 usage 汇总。
- 更好的多账号 X profile 管理。
- 发布失败后的重试、回滚或断点续发策略。
- 更丰富的平台模板，例如 WeChat / newsletter。
- 按发布目标生成内容：支持 `article --targets` / `pipeline --targets`，允许自由组合生成 `x-longform`、`x-thread`、`x-short`；发布阶段支持单目标 `--target`。详细任务说明见 [X-TARGET-OUTPUT-TASK.md](./X-TARGET-OUTPUT-TASK.md)。
- 可控视觉素材链路：从关键帧截图池生成 `available_visuals`，让长文/串推/短文只选择真实截图，并过滤屏幕中间为主播人像的候选帧。详细任务说明见 [VISUAL-CONTENT-TASK.md](./VISUAL-CONTENT-TASK.md)。

## 不在 v0.1 范围

- 自动绕过平台限制。
- 随仓保存用户 token、cookies 或 API key。
- 将历史 PR 验收文档作为当前操作手册维护。
- 在没有显式 `--publish auto` 的情况下真实发帖。
