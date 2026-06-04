# X 关注列表助手 — UX 重设计

- **日期**：2026-06-04
- **状态**：设计已确认，待规划实现
- **范围**：`packages/x-following-extension`

## 概述

对 Chrome MV3 扩展「X 关注列表助手」进行全面的 UX 和视觉重设计。保持现有功能（筛选未回关、勾选、批量取消关注），不增加新功能。聚焦在视觉美学、交互流畅度、信息层次的重构上。

功能保持不变：

- 筛选模式切换：仅未回关 / 全部
- 每行勾选框
- 全选列表 / 清除选择
- 批量取消关注（逐个 unfollow → 确认弹窗）

## 设计方向

- **风格**：精致现代 Premium Glass — 毛玻璃质感、柔和阴影、圆润边角、精致微交互
- **主题**：独立暗色设计语言（深蓝紫基底 `#0a0a14`），不完全跟随也不冲突 X 主题
- **字体**：系统字体栈（`-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif`），零外部依赖
- **布局**：内联集成栏，嵌入 X 页面流中（Tab 下方、用户列表上方），两行展开布局

## 视觉设计

### 配色系统

```
Base:       #0a0a14    — 最深底色
Surface:    #151525    — 卡片/面板底
Glass:      rgba(255,255,255,0.04) + blur(20px)  — 工具栏主体
Glass deep: rgba(24,24,44,0.88) + blur(40px)     — Dialog
Accent:     #818cf8 → #6366f1 (Indigo gradient)  — 强调色/选中态
Danger:     #ef4444    — 取消关注按钮
Success:    #10b981    — 完成状态
Warning:    #f59e0b    — 警告
Text pri:   rgba(255,255,255,0.9)
Text sec:   rgba(255,255,255,0.45)
Text dim:   rgba(255,255,255,0.25)
Border:     rgba(255,255,255,0.06)
```

### 玻璃质感层次

通过 `backdrop-filter: blur()` + 半透明背景 + 微妙边框 + 内阴影叠加营造深度：

1. **浅层玻璃**：`blur(8px)` + 低透明度 — 用于 hover 态
2. **中层玻璃**：`blur(20px)` + `rgba(18,18,32,0.7)` — 工具栏主体
3. **深层玻璃**：`blur(40px)` + `rgba(24,24,44,0.88)` — Dialog 弹窗

每层叠加：

- `border: 1px solid rgba(255,255,255,0.04-0.08)`
- `box-shadow: 0 8-16px 32-48px rgba(0,0,0,0.35-0.6)`
- `inset 0 0 0 1px rgba(255,255,255,0.03-0.05)`（模拟玻璃边缘高光）

背景氛围：深色渐变基底 + 散布的径向光晕（Indigo/Pink 色相，低透明度），营造有深度的空间感。

### 字体排版

```css
font-family: -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", sans-serif;
```

- 标题：14px / 700 / letter-spacing: -0.01em
- 正文：13px / 420
- 辅助文字：11-12px / 400 / 次要色
- 等宽数据（进度日志）：11px `'SF Mono', 'JetBrains Mono', monospace`

## 布局结构

### 工具栏（B2 展开双行）

```
┌──────────────────────────────────────┐
│ 关注列表助手 [BETA]   24人 6选 18未回关 │  ← Row 1: 标题 + 统计
│ ◉仅未回关 ○全部  [全选] [清除] [取关6] │  ← Row 2: 筛选 + 操作
└──────────────────────────────────────┘
```

- 位于 X 页面的 sticky tab 条下方、用户列表上方
- `position: sticky`，跟随 X 原生 sticky header 下方
- Row 1：左侧标题 + 右侧三个统计数字（列表人数 / 已选 / 未回关）
- Row 2：左侧分段筛选器（iOS 风格 segmented control）+ 右侧操作按钮
- 主操作按钮（取消关注）使用 Danger 色渐变 + 发光阴影

### 勾选框

- 替代原生 `<input type="checkbox">` 的外观
- 形状：44×44px 点击热区，内含 20×20px 圆角方形（`border-radius: 5px`）
- 未选中：`border: 1.5px solid rgba(255,255,255,0.12)` + 透明背景
- hover：边框变为 Indigo 色 + 微弱发光
- 已选中：Indigo 背景 + 白色 ✓ + 外发光 `box-shadow: 0 0 24px rgba(99,102,241,0.2)`
- 点击动画：弹性缩放 `scale(1.08)` → `scale(1)`，150ms，`cubic-bezier(.34,1.56,.64,1)`

### 筛选器

- iOS 风格 segmented control：圆角底槽 + 选中项滑动高亮
- 底槽：`background: rgba(255,255,255,0.04); border-radius: 10px; padding: 2px`
- 选中项：`background: rgba(129,140,248,0.22); border-radius: 8px`
- 文本：选中白色，未选中 40% 白色

## 交互流程

### 取消关注确认

**替换 `window.confirm()` → 浮层玻璃 Dialog**

1. 用户点击「取消关注 N 人」
2. 背景遮罩：`rgba(0,0,0,0.6)` + `backdrop-filter: blur(4px)`，fadeIn
3. Dialog 面板从中心弹出：`scale(0.9)→scale(1)` + `opacity 0→1`，200ms，`cubic-bezier(.16,1,.3,1)`
4. Dialog 内容：
   - 顶部圆形图标（红色警告）
   - 标题 "确认取消关注"
   - 描述文字（人数 + 不可撤销提醒）
   - 底部两个按钮：取消（次要）/ 确认取消关注（Danger 渐变）
5. 点击确认 → Dialog 关闭 → 进入进度态
6. 点击取消或遮罩 → Dialog 关闭

### 批量取关进度

工具栏替换为进度态：

```
┌──────────────────────────────────────┐
│ 正在取消关注…                  4 / 6 │  ← 标题 + 计数
│ ████████████░░░░░░░░░░░░ 65%        │  ← 渐变进度条 + 发光圆点
│ ✓ @indiedev · ✓ @designerx · ⏳ @joe│  ← 等宽日志流
└──────────────────────────────────────┘
```

- 进度条：4px 高，红→粉渐变，右侧发光圆点指示当前位置
- 动画：`width` transition 300ms ease-out
- 日志流：最多显示最近 3 条，新覆盖旧
- 成功：绿色 ✓ + 灰色 handle
- 失败：红色 ✗ + 灰色 handle
- 当前：旋转动画 spinner + handle

### 完成状态

```
┌──────────────────────────────────────┐
│ ✅ 完成！成功取消关注 6 人  [3秒后收起]│
└──────────────────────────────────────┘
```

- 绿色左边框强调
- 半透明绿色背景
- 3 秒延迟后自动收起（fadeOut + slideUp，500ms ease-in）

## 动效规范

| 场景             | 时长            | 缓动函数                              |
| ---------------- | --------------- | ------------------------------------- |
| 工具栏首次出现   | 250ms           | ease-out (fadeIn + slideDown)         |
| 勾选框点击       | 150ms           | `cubic-bezier(.34,1.56,.64,1)` (弹性) |
| Dialog 弹出/关闭 | 200ms           | `cubic-bezier(.16,1,.3,1)`            |
| 筛选器切换       | 200ms           | ease-out (高亮块滑动)                 |
| 进度条更新       | 300ms           | ease-out                              |
| 完成提示收起     | 500ms (3s 延迟) | ease-in (fadeOut + slideUp)           |
| hover 状态变化   | 150ms           | ease-out                              |

## 技术约束

### 保持不变

- Chrome MV3 架构（background service worker + content script）
- Shadow DOM 隔离样式
- MutationObserver 维持 DOM 生命周期
- Watchdog / activation retry 机制
- 现有的 `esbuild` 构建流程

### 变更范围

- **`src/ui/following-toolbar.ts`**：完全重写 — 新的 HTML 模板、CSS、交互逻辑
- **`src/dom/user-cell-checkbox.ts`**：替换原生 checkbox 为定制渲染
- **`src/content/following-manager.ts`**：适配新 toolbar API，添加 Dialog 状态管理
- **`src/dom/following-filter.ts`**：微调 CSS 注入逻辑
- **`src/background/background.ts`**：无改动
- **`src/manifest.json`**：无改动（版本号 bump 除外）

### 不自建（保持简洁）

- 不引入 React / Vue 等框架 — 原生 DOM + TypeScript
- 不引入 CSS 库或动画库 — CSS-only 动画
- 不引入外部字体 — 系统字体栈
- 不增加新的外部依赖

## 代码结构

```
src/
├── background/background.ts    # 无改动
├── content/following-manager.ts # 适配新 toolbar API + Dialog 状态
├── dom/
│   ├── following-filter.ts     # CSS 注入微调
│   ├── user-cell-checkbox.ts   # 定制勾选框渲染
│   └── x-session.ts            # 无改动
├── ui/
│   └── following-toolbar.ts    # 完全重写 — 玻璃面板 UI
├── icons/                      # 无改动（可考虑更新图标）
└── manifest.json               # 版本号 bump
```

## 非功能需求

- **性能**：动画仅使用 CSS transition/transform（GPU 加速），不触发 layout
- **可访问性**：保持 `aria-label`，勾选框可键盘操作
- **兼容性**：Chrome 120+（与现有 `esbuild` target 一致）
- **尺寸**：扩展包体不增加（纯 CSS + 模板字符串，无新依赖）
