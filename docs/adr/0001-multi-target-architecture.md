# ADR-0001: 多端架构与 Monorepo

- **Status**: Accepted
- **Date**: 2026-05-14
- **Deciders**: 项目负责人
- **Tags**: architecture, monorepo, multi-target

## Context

项目原定位为「本地 Node CLI」。早期方案曾考虑单包 CLI，后来因多端扩展和开源维护需求，改为 monorepo。

但在 2026-05-14 的 review 中，明确未来要支持：

- 本地 CLI（当前）
- Chrome 扩展（差异化价值，能直接操作 x.com DOM 绕过 API 限制）
- 项目要开源发布

**关键约束**：

| 能力                        | Node                 | 浏览器（扩展）                |
| --------------------------- | -------------------- | ----------------------------- |
| yt-dlp 采集 / FFmpeg 关键帧 | ✅                   | ❌                            |
| LLM HTTP 调用               | ✅                   | ✅                            |
| 文件系统                    | ✅                   | ⚠️ chrome.storage / downloads |
| OAuth 授权                  | 本地 callback server | chrome.identity               |
| X 发布                      | API 或 Puppeteer     | API 或直接操控 DOM（无 CORS） |
| Markdown 处理 / 平台改写    | ✅                   | ✅                            |

**结论**：领域逻辑（markdown / platform / oauth2 流程 / schema）**两端都能跑**；外部 IO（fs / yt-dlp / x-api）**强环境绑定**。

## Decision

### 1. 采用 Hexagonal (Ports & Adapters) 架构

- **Ports**（接口）定义在 `packages/core/src/ports/`，零 Node 依赖。
- **Adapters**（实现）按运行环境拆包：当前 **`adapters-node`**；v0.2 计划 **`adapters-browser` / `adapters-extension`**（仓库尚未包含）。
- **Domain**（业务逻辑）只依赖 ports，不依赖具体 adapter。

### 2. 使用 pnpm workspace 拆分为 monorepo

撤回原 PLAN §10「不做 monorepo」的决策。

```text
yt2x/
├─ pnpm-workspace.yaml
├─ package.json                     # root, devDependencies 共享
├─ packages/
│  ├─ core/                         # 零 Node 依赖，可跑浏览器
│  │  └─ src/
│  │     ├─ domain/                 # markdown / platform / pipeline / oauth2 状态机
│  │     ├─ ports/                  # LlmPort, StoragePort, HttpPort, OAuth2Port
│  │     └─ schema/                 # 所有 Zod schemas
│  ├─ adapters-node/                # fs / execa / yt-dlp / FFmpeg
│  ├─ adapters-extension/           # v0.2 计划（chrome.storage / x-dom-poster）
│  ├─ cli/                          # 本地 yt2x 命令（v0.1 主交付）
│  └─ extension/                    # Chrome MV3（v0.2）
├─ apps/                            # 预留，目前为空
├─ docs/
└─ scripts/
```

### 3. Chrome 扩展采用「完全独立」模式

- 扩展**不与本地 CLI 通信**（不走 Native Messaging，不走 Local HTTP）。
- 扩展独立调用 LLM API + 直接操作 x.com DOM 发推。
- 与 CLI **仅共享** `packages/core`。

### 4. 扩展能力范围：触发 + 发布

- 在 YouTube 页面 toolbar 一键提交 URL → 后台跑流水线 → 发布到 x.com。
- 不做内嵌历史管理、复杂编辑器 UI。

### 5. 节奏：CLI first

- **v0.1**：仅交付 CLI（4 周）
- **v0.2+**：再做扩展，见 [ROADMAP.md](../ROADMAP.md)

## Consequences

### Positive

- 领域逻辑一次实现，多端复用，零重复。
- `packages/core` 可发布为独立 npm 包，让别人复用「采集→改写→发布」的核心能力。
- pnpm workspace 比 Turborepo/Nx 学习成本最低，符合开源贡献者友好原则。
- CLI first 让 v0.1 风险可控，避免一次铺太大。

### Negative

- 比原「单包」方案多一层目录与配置复杂度（pnpm-workspace.yaml、跨包导入路径）。
- ESM + workspace 的类型导出在某些工具链下需要额外配置（`exports` 字段、`tsconfig` paths）。

### Neutral

- 暂不引入 Turborepo / Nx 等 monorepo 构建工具，等扩展到 5+ 包再评估。

## Open Questions

### v0.2 扩展采集路径

「扩展独立 + 完整闭环」与「yt-dlp 必须 Node」存在技术矛盾。v0.2 启动前必须从以下三选一：

| 选项                | 描述                                                  | 利弊                                |
| ------------------- | ----------------------------------------------------- | ----------------------------------- |
| A. 改协作方式       | 扩展通过 Local HTTP 调本地 CLI（撤回本 ADR §3）       | 能力最强；用户需常驻 `yt2x serve`   |
| B. 浏览器侧字幕抓取 | 扩展直接从 YouTube 网页 DOM/InnerTube API 拿字幕      | 无外部依赖；脆弱，依赖 YouTube 不改 |
| C. 扩展退化为发布器 | 扩展只读取本地 article.md 一键发布，采集仍由 CLI 完成 | 最稳；用户体验不闭环                |

**当前决策**：v0.1 不阻塞，后续按 [ROADMAP.md](../ROADMAP.md) 排期。

## Alternatives Considered

### Option A: 不做 monorepo，扩展独立仓库

- **优点**：单包简单，CLI 与扩展互不影响。
- **缺点**：业务逻辑必然在两个仓库重复维护，长期必漂移。
- **否决原因**：违反 DRY，开源后贡献者难定位「真理来源」。

### Option B: Turborepo / Nx

- **优点**：缓存与并行构建强大。
- **缺点**：学习成本高，目前只有 2 个 package 不需要。
- **否决原因**：YAGNI。pnpm workspace 在 < 5 包场景足够。

### Option C: Local HTTP 模式（扩展 ←→ CLI）

- **优点**：扩展能力完整（含 yt-dlp 采集）。
- **缺点**：用户需保持 `yt2x serve` 进程；增加攻击面（localhost 端口）。
- **否决原因**：UX 复杂，对扩展用户不友好。可作为 v0.2 备选。

### Option D: Native Messaging

- **优点**：能力完整，无端口暴露。
- **缺点**：需要安装 manifest 文件到 Chrome native messaging 目录，跨平台路径差异大。
- **否决原因**：安装复杂度对开源用户门槛太高。

## References

- Hexagonal Architecture: [Alistair Cockburn 原文](https://alistair.cockburn.us/hexagonal-architecture/)
- pnpm workspace: <https://pnpm.io/workspaces>
- Chrome MV3: <https://developer.chrome.com/docs/extensions/mv3/intro/>
