# Final Remediation B 报告

状态：DONE_WITH_CONCERNS

## 本批次完成

- 新增 profile-aware content cache metadata，比较 source、model、promptVersion、technicalTermProfileFingerprint 和 discovery audit；缺少新字段的旧 metadata 视为 stale，命中判断不会调用 discovery/provider。
- native article、X thread、X short、X video-short、platform article，以及 clip post 接入缓存元数据；目标文件存在但 metadata 不匹配时会安全重建。
- thread/short/video-short/platform article 在 visual 清理、字段规范化等后处理后重新执行最终术语校验和 schema 校验；短帖覆盖了术语只存在于被删除 visual 的回归场景。
- deconstruct 先在内存中准备 manifest、帖子和选中状态，再进行逐 clip 作用域术语校验、最终 manifest schema 校验；帖子、manifest、clip-post metadata 写入临时目录后原子替换。失败时不触碰旧成功字节，兼容旧 manifest 的 sourceContext 缺失场景。
- clip post 的术语校验按选中 clip 的真实 source scope 执行，避免一个 clip 的术语出现掩盖另一个 clip 缺失；YouTube 控制链接按输出契约单独放行。

## TDD 与验证

先加入失败测试，初始 RED 包含：缓存模块缺失、删除 invalid visual 后错误放行、deconstruct 失败仍可覆盖旧产物，以及 staged manifest API 缺失。随后完成最小实现并转为 GREEN。

已运行：

- 定向 Vitest：15 个相关测试文件，118 tests passed。
- `pnpm typecheck`：通过。
- `git diff --check`：通过。

没有运行全量测试；由控制器负责。所有 provider 调用均为测试替身，产物只写入临时 fixture。

## 关注项

按本批次明确边界，未修改 subtitle-tools、`files/downloads/`、Dashboard 和 XHS 专项流程。native notes 仍沿用现有 process-status/file-exists 跳过语义，因此“notes 的 profile-aware cache”需要在允许处理 downloads 的后续批次补齐；这也是本报告标记 DONE_WITH_CONCERNS 的原因。
