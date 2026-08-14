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

## Final Remediation B 修复轮次 2

状态：DONE

本轮完成 reviewer 的 4 Important 与 Minor 收口：

1. deconstruct 候选缓存身份现在覆盖当前 SRT 内容 SHA、视频规范路径与完整内容 SHA/stat、duration、article、requested model、选择参数、候选/clip-post/discovery prompt 版本及术语目录身份。CLI 在创建候选或帖子 provider 前分别验证 candidate 与 clip-post metadata；两者完全命中才零 provider。候选 discovery profile/audit 与 clip-post profile/audit 分开持久化。
2. 摘要 guard 改为双层语义：父级全文 profile 负责 known canonical、forbidden translation 与 invented term 判断，派生 scope 只负责 required/missing。thread、short、video-short 与 deconstruct 可合法省略未讨论细节；主动写错已知术语仍失败，canonical 原文不会误报 invented。长文 article 使用全文 required contract，不再缩到固定摘要章节。
3. `writeSelectedPostFiles` 和 `generateClipsPosts(persist=true)` 的直接路径改为完整 generation staging，再通过版本目录和单个 active 符号链接原子切换。post、manifest、clip-post metadata 同属一个 generation；注入提交中断时旧三类字节保持不变。CLI staging 显式由外层事务提交，二者复用同一目录提交 helper。
4. 所有 content writer 的锁路径只由规范化 bundle/root 决定，caller label 不参与 key。真实 `native-content` 锁与 direct article/x-short writer 组合测试证明互斥。临时文件、post stage、generation 和 pointer 使用 `randomUUID`，失败路径清理未提交临时项。
5. 首次旧实体目录迁移写入兼容 fallback marker；readiness、publisher 与 selector 在 active pointer 切换窗口可解析旧 generation。旧 generation 不在切换后立即删除，避免已经解析 fallback 的并发 reader 失去可读路径。

### TDD 证据

- deconstruct identity 测试先因 helper 缺失 RED，随后验证 SRT、视频字节、duration、requested model、selectCount 任一变化都会 stale，视频符号链接与真实规范路径身份一致。
- 双层 guard 三态测试先因误译未被识别 RED，随后验证：省略详细 Context Engineering 合法；主动写“上下文工程”失败；写 Context Engineering 不算 invented。
- direct post bundle 提交中断测试先错误成功并覆盖旧路径，随后转绿，确认旧 manifest、post、metadata 字节均不变。
- 锁命名空间测试先因 caller label 生成不同锁 RED，随后以真实 article/x-short writer 验证统一互斥。
- 首次迁移窗口测试先因 fallback resolver 缺失 RED，随后在 pointer commit 注入中断时仍能读取旧 generation。

### 本轮验证

- reviewer 相关定向 Vitest：10 个测试文件，146 tests passed。
- `pnpm typecheck`：通过。
- `git diff --check`：通过。

按要求未运行全量测试、真实 provider、真实媒体或 `files/` 流程；未修改字幕、Dashboard 和 XHS。

## Round 3

状态：DONE（收尾，Remediation C/D 按用户要求暂停）

### 保留的修复

1. **content metadata schema v2 → v3**：持久化 `technicalTermKnownSourceFingerprint`、`technicalTermRequiredSourceFingerprint`、`technicalTermScope`，freshness 用它们精确重建生成时的双层 guard。thread/short/video-short 走 `scoped`，article/platform-article/notes/deconstruct-run/clip-post 走 `full`。full-scope target 的 v2 记录可迁移（`known = required = discovery.sourceIdentity`），scoped target 无法重建 required 层，仍判 stale。
2. **deconstruct 缓存身份分离**：`deconstruct` target 更名 `deconstruct-run`，只由候选输入身份决定；`selectedClipPostCacheIdentityFor()` 只由选中片段构成 clip-post 身份。两者在任何 provider 创建之前分别比较。`deconstructCacheIdentityFor` 不再混入 `promptVersions.clipPost`。
3. **clip-post 重建缺陷**：`selectedClipPostCacheIdentityFor` 的 `sourceText` 此前忽略 `clip.sourceContext` 而 `sourceFingerprint` 使用它，生产环境 clip-post 缓存永不命中。抽出 `clipSourceTextForSelection` 统一两侧。
4. **guard 与身份过滤条件统一**：`finalGuard` 与 `selectedClipPostCacheIdentityFor` 都用 `selected === true && Boolean(clip.text)`，消除空 text 片段导致的指纹错位与 post 文件编号跳号。
5. **锁身份规范化**：`canonicalContentTargetPath` 对已存在部分做 realpath、未创建部分作后缀拼回，`files/...` 符号链接与真实路径得到同一把锁。
6. 小修：`sourceTitle` 回退统一为 videoId；`NativeArticleRunRecord.v` 收紧；删除死代码 `clipPostSourceFingerprintFor`。

### 主动放弃的方向

Round 3 中途曾按前一轮审查意见实现「稳定实体 root + 不可变 `.generations` + 原子 `.active-generation` 指针 + 硬链接铺回 + 有界 GC」，用于消除 bundle 换入时 root 的短暂不存在窗口。该方案共约 300 行，并连续两轮独立审查中引入新的正确性缺陷（硬链接 staging 上 `writeFile` 的 `O_TRUNC` 穿透改写已发布 generation；pending-sweep 删除当前铺回在 root 上的交付物；公开 clips 目录对用户显示为空）。

评估后整体移除：yt2x 是单用户本地 CLI，所有 bundle 写入方都在同一把 target 锁内串行，读取方是命令结束后的人或脚本，该窗口不构成实际风险，而消除它的机制成本与缺陷率远高于收益。`replaceDirectoryAtomically` 回到「旧目录改名备份 → staged 改名换入 → 删除备份，失败则把备份改回」的简单换入，`x-format/clips/` 恢复为普通目录，交付物直接可见。

### 验证

- 全量 `pnpm test`：133 files / 1640 tests passed。
- `pnpm run typecheck`：通过。
- `git diff --check`：通过。
- `pnpm run check:downloads`：clean。
- 改动文件定向 `eslint` 与 `prettier --check`：通过。

未运行真实 provider、TTS、ffmpeg 或媒体流程；未写入 `files/downloads/`；未修改字幕、Dashboard、XHS。
