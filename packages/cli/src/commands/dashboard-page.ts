import { DASHBOARD_CLIENT } from "./dashboard-client.js";
import { DASHBOARD_STYLE } from "./dashboard-style.js";

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>yt2x Dashboard</title>
  <style>${DASHBOARD_STYLE}</style>
</head>
<body>
  <header>
    <div>
      <h1>yt2x 控制台</h1>
      <div class="sub" id="sourceLine">扫描本地文件中...</div>
    </div>
    <div class="filters">
      <input id="search" placeholder="搜索标题、videoId、备注或链接" />
      <select id="platformFilter">
        <option value="all">全部平台</option>
        <option value="x">X</option>
        <option value="xiaohongshu">小红书</option>
        <option value="wechat">公众号</option>
        <option value="bilibili">B站</option>
      </select>
      <select id="statusFilter">
        <option value="all">全部状态</option>
        <option value="generated">已有稿件</option>
        <option value="published">已发布</option>
        <option value="unpublished">未发布</option>
      </select>
    </div>
    <button id="refresh">刷新</button>
  </header>
  <main>
    <section class="table-wrap">
      <div class="summary" id="summary"></div>
      <table>
        <thead>
          <tr>
            <th>视频</th>
            <th>更新时间</th>
            <th>X</th>
            <th>小红书</th>
            <th>公众号</th>
            <th>B站</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
    <aside id="detail">
      <div class="empty">选择一个视频查看稿件和发布状态。</div>
    </aside>
  </main>
  <div class="modal-overlay" id="themeModal">
    <section class="theme-modal" role="dialog" aria-modal="true" aria-labelledby="themeModalTitle">
      <div class="theme-modal-head">
        <div class="head-left">
          <div class="theme-modal-icon">🎨</div>
          <div>
            <div class="theme-modal-title" id="themeModalTitle">选择公众号排版风格</div>
            <div class="theme-modal-sub">点星标收藏，收藏的风格会固定在顶部显示</div>
          </div>
        </div>
        <button class="secondary" id="themeModalClose">关闭</button>
      </div>
      <div class="theme-search-wrap">
        <input id="themeSearch" placeholder="搜索风格名称、ID 或描述…" />
      </div>
      <div class="theme-list" id="themeList">
        <div class="theme-empty">正在加载风格...</div>
      </div>
      <div class="theme-modal-foot">
        <button class="secondary" id="themeModalCancel">取消</button>
        <button id="themeModalSubmit">开始排版</button>
      </div>
    </section>
  </div>
  <div class="toast" id="toast"></div>
  <script>${DASHBOARD_CLIENT}</script>
</body>
</html>`;

