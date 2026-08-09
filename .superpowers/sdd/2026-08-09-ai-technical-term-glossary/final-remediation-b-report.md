# Final Remediation B 报告

状态：DONE

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

按本批次明确边界，未修改 subtitle-tools、`files/downloads/`、Dashboard 和 XHS 专项流程。

## Final Remediation B 修复轮次 1

本轮已消除上一版关注项，并完成 reviewer 的 7 项收口：

1. native notes 改为 profile-aware cache。缓存身份持久化 source、requestedModel、resolvedModel、promptVersion、profileFingerprint 和 discoveryAudit；旧 metadata stale，完全命中时 discovery/provider 调用为零。
2. 真实 CLI deconstruct 在候选识别和帖子生成前检查完整 bundle cache；persist:false 仅允许显式声明已履行 CLI cache contract 的 staging 调用。
3. article、thread、short、video-short 和 deconstruct 的术语 active scope 来自真实摘要区段或选中 clip source；未讨论的源术语允许省略，选中字段中的遗漏或误译仍严格失败或修复。
4. metadata 分离 requestedModel 与 resolvedModel，cache key 只比较 requestedModel；v1 model 记录可安全迁移。
5. deconstruct 在独立 staging generation 中完成 manifest、帖子、metadata、视频裁剪与 readiness；成功后把 generation 移入版本目录，并通过单次原子 rename 切换兼容旧路径的 clips 符号链接。旧实体目录可迁移，提交失败可恢复。
6. article、notes、platform article、thread、short、video-short、deconstruct 使用可复用的目标级跨进程锁；锁支持超时、过期进程回收和 finally 清理。并发测试直接验证正文与 metadata 最终属于同一 generation。
7. 原子文件和 staging/pointer 名称使用随机唯一后缀，失败路径清理临时文件与未提交 generation。

### deconstruct 事务证据

- readiness 失败：CLI production orchestration 测试在临时目录保留旧 manifest/post，确认 readiness 针对 staging 路径执行且未调用 commit。
- pointer 提交中断：真实文件系统测试在第二次 generation 的单原子 pointer rename 注入失败，确认旧符号链接和旧正文仍可读取。
- 旧目录提交中断：真实文件系统测试确认首次迁移失败时旧实体目录恢复。
- 成功路径：真实文件系统测试确认正文和 metadata 一起切换到新 generation，旧路径读取保持兼容。

### 本轮验证

- 最终定向 Vitest：8 个测试文件，52 tests passed。
- 补充并发 generation 断言：1 个测试文件，5 tests passed。
- pnpm typecheck：通过。
- git diff --check：通过。

按控制器要求未运行全量测试、lint 或真实 provider/media 流程；所有测试仅使用临时 fixture。字幕、Dashboard 和 XHS 未改动。
