# yt2x Roadmap

本文件只记录当前仍有行动价值的路线图。历史 PR 验收稿和旧重构蓝图已从仓库文档中删除；当前完成度快照见 [REFACTOR-STATUS.md](./REFACTOR-STATUS.md)。

## 当前阶段

yt2x 处于 v0.1 开源前打磨期：

- CLI first。
- 全阶段 native：`acquire`、`notes`、`article`、`publish`、`pipeline`。
- 已支持多目标内容生成与发布预览：`article`、`x-thread`、`x-short`、`x-thread-short`。
- 已支持可控视觉素材链路：`acquire --keyframes` 生成截图 manifest，内容生成阶段使用 `available_visuals`，长文、串推和短文只引用真实可用截图，发布阶段可消费配图计划。
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

- 内容质量规则层：提升 Article / Short / Thread 的 X 平台适配、移动端可读性、风险边界、可执行资产与质量检查，见 [CONTENT-QUALITY-TASK.md](./CONTENT-QUALITY-TASK.md)（**Task 1–7 已完成**）。
- **X Articles 发布安全与草稿通道**：先交付已知安全修复，阻断 `publish --target article`
  在非 dry-run 下误走 Tweet API；随后将 `article.md` 写入 X Articles 草稿箱（无 API）。
  详见 [ARTICLE-DRAFT-PUBLISH-TASK.md](./ARTICLE-DRAFT-PUBLISH-TASK.md)（**最早安全交付 Task 7；Task 1–15 未开始**）。
- Chrome 扩展或浏览器侧工作流（可与 Article 草稿任务合并规划，见上）。
- LLM streaming 输出。
- 本地模型 / Ollama provider。
- 更细的成本统计与 usage 汇总。
- 更好的多账号 X profile 管理。
- 发布失败后的重试、回滚或断点续发策略。
- 更丰富的平台模板，例如 WeChat / newsletter。

## v2.0 方向

- 可选视频片段下载：`--download-video` 默认下载播放热度最高区域附近 30 秒。
- 单独视频下载模式：`yt2x acquire --video-only` 只下载视频片段，不生成字幕和转写。
- 手动时间段下载：`--video-start` / `--video-end` 指定片段范围。
- 详细任务拆分见 [VIDEO-DOWNLOAD-V2-TASK.md](./VIDEO-DOWNLOAD-V2-TASK.md)。

## 不在 v0.1 范围

- 自动绕过平台限制。
- 随仓保存用户 token、cookies 或 API key。
- 将历史 PR 验收文档作为当前操作手册维护。
- 在没有显式 `--publish auto` 的情况下真实发帖。
