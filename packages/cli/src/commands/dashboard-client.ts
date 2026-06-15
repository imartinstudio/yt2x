export const DASHBOARD_CLIENT = String.raw`    const platformLabels = { x: "X", xiaohongshu: "小红书", wechat: "公众号", bilibili: "B站" };
    const platformOrder = ["x", "xiaohongshu", "wechat", "bilibili"];
    let payload = null;
    let selectedId = null;
    let wechatThemes = [];
    let themeModalVideoId = null;
    let selectedWechatTheme = "notion-doc";
    let favoriteThemes = [];
    const favoriteThemeStorageKey = "yt2x.wechat.favoriteThemes";

    const $ = (id) => document.getElementById(id);
    const toast = (text) => {
      const el = $("toast");
      el.textContent = text;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 3500);
    };
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-";
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    async function load() {
      const resp = await fetch("/api/videos");
      payload = await resp.json();
      if (!selectedId && payload.videos.length > 0) selectedId = payload.videos[0].videoId;
      $("sourceLine").textContent = payload.videos.length + " 个视频 · " + payload.articleOutDir;
      render();
    }

    async function loadWechatThemes() {
      try {
        const resp = await fetch("/api/wechat-themes");
        if (!resp.ok) throw new Error("theme api failed");
        const data = await resp.json();
        wechatThemes = Array.isArray(data.themes) ? data.themes : [];
      } catch {
        wechatThemes = [{ id: "github", name: "GitHub", description: "默认主题" }];
      }
      readFavoriteThemes();
    }

    function readFavoriteThemes() {
      try {
        const parsed = JSON.parse(localStorage.getItem(favoriteThemeStorageKey) || "[]");
        favoriteThemes = Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
      } catch {
        favoriteThemes = [];
      }
    }

    function writeFavoriteThemes() {
      localStorage.setItem(favoriteThemeStorageKey, JSON.stringify(favoriteThemes));
    }

    function isFavoriteTheme(themeId) {
      return favoriteThemes.includes(themeId);
    }

    function toggleFavoriteTheme(themeId) {
      if (isFavoriteTheme(themeId)) {
        favoriteThemes = favoriteThemes.filter((item) => item !== themeId);
      } else {
        favoriteThemes = [themeId, ...favoriteThemes];
      }
      writeFavoriteThemes();
      renderThemeList();
    }

    function filteredVideos() {
      const q = $("search").value.trim().toLowerCase();
      const platform = $("platformFilter").value;
      const status = $("statusFilter").value;
      return payload.videos.filter((video) => {
        const blob = [
          video.videoId,
          video.title,
          ...platformOrder.flatMap((p) => [video.platforms[p].url, video.platforms[p].note, video.platforms[p].files.join(" ")])
        ].join("\n").toLowerCase();
        if (q && !blob.includes(q)) return false;
        const platforms = platform === "all" ? platformOrder : [platform];
        if (status === "generated" && !platforms.some((p) => video.platforms[p].generated)) return false;
        if (status === "published" && !platforms.some((p) => video.platforms[p].published)) return false;
        if (status === "unpublished" && !platforms.some((p) => video.platforms[p].generated && !video.platforms[p].published)) return false;
        return true;
      });
    }

    function renderSummary(videos) {
      const total = videos.length;
      const generated = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].generated).length, 0);
      const published = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].published).length, 0);
      const waiting = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].generated && !v.platforms[p].published).length, 0);
      $("summary").innerHTML = [
        ["视频", total],
        ["已生成平台稿", generated],
        ["已发布", published],
        ["待发布", waiting],
      ].map(([label, value]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join("");
    }

    function platformPill(state) {
      if (state.published) return '<span class="pill published">已发布</span>';
      if (state.generated) return '<span class="pill generated">未发布</span>';
      return '<span class="pill">无稿件</span>';
    }

    function selectVideo(videoId) {
      if (selectedId === videoId) return;
      // remove old active without full re-render
      const prev = document.querySelector("tr.active");
      if (prev) prev.classList.remove("active");
      selectedId = videoId;
      // highlight new row
      const next = document.querySelector('tr[data-id="' + CSS.escape(videoId) + '"]');
      if (next) next.classList.add("active");
      // only re-render detail panel
      renderDetail();
    }

    function renderRows(videos) {
      $("rows").innerHTML = videos.map((video) => [
        '<tr class="' + (video.videoId === selectedId ? "active" : "") + '" data-id="' + esc(video.videoId) + '">',
        '<td><div class="title">' + esc(video.title) + '</div>' +
          (video.originalTitle ? '<div class="original-title">' + esc(video.originalTitle) + '</div>' : "") +
          '<div class="video-id">' + esc(video.videoId) + '</div></td>',
        '<td class="date">' + esc(fmtDate(video.updatedAt)) + '</td>',
        platformOrder.map((p) => '<td class="platform-cell">' + platformPill(video.platforms[p]) + '</td>').join(""),
        '</tr>',
      ].join("")).join("");
      document.querySelectorAll("tr[data-id]").forEach((row) => {
        row.addEventListener("click", () => {
          selectVideo(row.dataset.id);
        });
      });
    }

    function swapDetailHTML(html) {
      const detail = $("detail");
      // save scroll position before swapping content
      const scrollTop = detail.scrollTop;
      // build a DocumentFragment and replace children atomically
      const template = document.createElement("template");
      template.innerHTML = html;
      detail.replaceChildren(template.content);
      // restore scroll position
      detail.scrollTop = scrollTop;
    }

    function renderDetail() {
      const video = payload.videos.find((item) => item.videoId === selectedId);
      if (!video) {
        swapDetailHTML('<div class="empty">没有匹配的视频。</div>');
        return;
      }
      const html = [
        '<h2 class="detail-title">' + esc(video.title) + '</h2>',
        video.originalTitle ? '<div class="detail-original-title">原视频标题：' + esc(video.originalTitle) + '</div>' : "",
        '<div class="detail-meta">' + esc(video.videoId) + '<br>' + esc(video.articleDir || "无 article 目录") + '</div>',
        platformOrder.map((p) => renderPlatformCard(video, p)).join(""),
      ].join("");
      swapDetailHTML(html);
      $("detail").querySelectorAll("[data-save]").forEach((btn) => {
        btn.addEventListener("click", () => savePlatform(video.videoId, btn.dataset.save, btn.dataset.value));
      });
      $("detail").querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", () => copyPlatform(video.videoId, btn.dataset.copy));
      });
      $("detail").querySelectorAll("[data-format-wechat]").forEach((btn) => {
        btn.addEventListener("click", () => openThemeModal(video.videoId, btn.dataset.theme || "notion-doc"));
      });
      $("detail").querySelectorAll("[data-copy-wechat-html]").forEach((btn) => {
        btn.addEventListener("click", () => copyWechatHtml(video.videoId));
      });
      $("detail").querySelectorAll("[data-format-platform]").forEach((btn) => {
        btn.addEventListener("click", () => formatPlatform(video.videoId, btn.dataset.formatPlatform));
      });
    }

    async function formatPlatform(videoId, platform) {
      toast("开始" + (platformLabels[platform] || platform) + "排版...");
      const resp = await fetch("/api/platform-format", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, platform }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        toast(data.error || "排版失败");
        await load();
        return;
      }
      toast((platformLabels[platform] || platform) + "排版完成");
      await load();
    }

    function renderPlatformCard(video, platform) {
      const state = video.platforms[platform];
      const formatLine = platform === "wechat"
        ? '<div class="file-list">排版：' +
          (state.formatStatus === "formatted"
            ? "已排版" + (state.formatTheme ? " · " + esc(state.formatTheme) : "")
            : state.formatStatus === "failed"
              ? "失败 · " + esc(state.formatError || "未知错误")
              : "未排版") +
          '</div>'
        : "";
      // format button is enabled if platform article OR base article.md exists
      const canFormat = state.generated || video.platforms.x.generated;
      const formatLabel = state.formatStatus === "formatted" ? "重新排版" : "排版";
      const orchPreviewLink = '<a href="/api/platform-orchestrate/preview?videoId=' + encodeURIComponent(video.videoId) + '&platform=' + platform + '" target="_blank"><button class="secondary">编排预览</button></a>';
      const wechatActions = platform === "wechat"
        ? [
          canFormat
            ? '<button class="secondary" data-format-wechat="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "notion-doc") + '">' + formatLabel + '</button>'
            : '<button class="secondary" disabled>缺稿件</button>',
          '<button class="secondary" data-copy-wechat-html="' + esc(video.videoId) + '" ' + (state.formatStatus === "formatted" ? "" : "disabled") + '>复制 HTML</button>',
          '<a href="/api/wechat-format/file?videoId=' + encodeURIComponent(video.videoId) + '&kind=preview" target="_blank"><button class="secondary" ' + (state.formatStatus === "formatted" ? "" : "disabled") + '>打开预览</button></a>',
          orchPreviewLink,
        ].join("")
        : "";
      const platformFormatActions = platform === "xiaohongshu"
        ? [
          canFormat
            ? '<button class="secondary" data-format-platform="xiaohongshu">' + formatLabel + '</button>'
            : '<button class="secondary" disabled>缺稿件</button>',
          '<a href="/api/xiaohongshu-format/file?videoId=' + encodeURIComponent(video.videoId) + '" target="_blank"><button class="secondary">打开预览</button></a>',
          orchPreviewLink,
        ].join("")
        : "";
      const bilibiliFormatActions = platform === "bilibili"
        ? [
          canFormat
            ? '<button class="secondary" data-format-platform="bilibili">' + formatLabel + '</button>'
            : '<button class="secondary" disabled>缺稿件</button>',
          '<a href="/api/bilibili-format/file?videoId=' + encodeURIComponent(video.videoId) + '" target="_blank"><button class="secondary">打开预览</button></a>',
          orchPreviewLink,
        ].join("")
        : "";
      return [
        '<section class="platform-card">',
        '<div class="platform-head">',
        '<div>',
        '<div class="platform-name">' + platformLabels[platform] + '</div>',
        '<div class="file-list">' + (state.files.length ? state.files.map(esc).join(" · ") : "未生成稿件") + '</div>',
        formatLine,
        '</div>',
        '<div class="switch">',
        '<button data-save="' + platform + '" data-value="false" class="' + (!state.published ? "on" : "") + '">未发布</button>',
        '<button data-save="' + platform + '" data-value="true" class="' + (state.published ? "on" : "") + '">已发布</button>',
        '</div>',
        '</div>',
        '<input data-url="' + platform + '" placeholder="发布链接" value="' + esc(state.url) + '" />',
        '<textarea data-note="' + platform + '" placeholder="备注">' + esc(state.note) + '</textarea>',
        '<div class="actions">',
        '<button data-save="' + platform + '" data-value="' + String(state.published) + '">保存状态</button>',
        '<button class="secondary" data-copy="' + platform + '" ' + (state.generated ? "" : "disabled") + '>复制稿件</button>',
        '<a href="/api/file?videoId=' + encodeURIComponent(video.videoId) + '&platform=' + platform + '" target="_blank"><button class="secondary" ' + (state.generated ? "" : "disabled") + '>打开稿件</button></a>',
        wechatActions,
        platformFormatActions,
        bilibiliFormatActions,
        '</div>',
        '</section>',
      ].join("");
    }

    async function savePlatform(videoId, platform, value) {
      const active = value === "true";
      const url = document.querySelector('[data-url="' + platform + '"]').value;
      const note = document.querySelector('[data-note="' + platform + '"]').value;
      const resp = await fetch("/api/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, platform, published: active, url, note }),
      });
      if (!resp.ok) {
        toast("保存失败");
        return;
      }
      toast("已保存");
      await load();
    }

    async function copyPlatform(videoId, platform) {
      const resp = await fetch("/api/file?videoId=" + encodeURIComponent(videoId) + "&platform=" + platform);
      if (!resp.ok) {
        toast("没有可复制的稿件");
        return;
      }
      await navigator.clipboard.writeText(await resp.text());
      toast("已复制稿件");
    }

    function openThemeModal(videoId, theme) {
      themeModalVideoId = videoId;
      selectedWechatTheme = theme || "notion-doc";
      $("themeSearch").value = "";
      renderThemeList();
      $("themeModal").classList.add("open");
    }

    function closeThemeModal() {
      $("themeModal").classList.remove("open");
      themeModalVideoId = null;
    }

    function themeById(themeId) {
      return wechatThemes.find((theme) => theme.id === themeId);
    }

    function themeCard(theme) {
      const favorite = isFavoriteTheme(theme.id);
      const selected = theme.id === selectedWechatTheme;
      const preview = theme.description
        ? theme.description.slice(0, 38) + (theme.description.length > 38 ? "…" : "")
        : "预览效果 · 排版风格";
      // generate a deterministic hue from the theme id for the accent swatch
      let hash = 0;
      for (let i = 0; i < theme.id.length; i++) hash = ((hash << 5) - hash) + theme.id.charCodeAt(i);
      const hue = Math.abs(hash) % 360;
      return [
        '<div class="theme-card' + (selected ? " selected" : "") + '" data-select-theme="' + esc(theme.id) + '">',
        '<div class="theme-card-ink" style="--card-hue:' + hue + '"></div>',
        '<button class="theme-fav' + (favorite ? " on" : "") + '" data-favorite-theme="' + esc(theme.id) + '" title="' + (favorite ? "取消收藏" : "收藏风格") + '" aria-label="' + (favorite ? "取消收藏" : "收藏风格") + '">' + (favorite ? "★" : "☆") + '</button>',
        '<div class="theme-card-body">',
        '<span class="theme-name">' + esc(theme.name || theme.id) + '</span>',
        '<span class="theme-id">' + esc(theme.id) + '</span>',
        theme.description ? '<span class="theme-desc">' + esc(theme.description) + '</span>' : "",
        '<span class="theme-preview">' + esc(preview) + '</span>',
        selected ? '<span class="theme-check">✓</span>' : "",
        '</div>',
        '</div>',
      ].join("");
    }

    function themeSection(title, themes) {
      if (themes.length === 0) return "";
      return [
        '<section class="theme-section">',
        '<div class="theme-section-title">' + esc(title) + '</div>',
        '<div class="theme-grid">' + themes.map(themeCard).join("") + '</div>',
        '</section>',
      ].join("");
    }

    function bindThemeListEvents() {
      $("themeList").querySelectorAll("[data-select-theme]").forEach((card) => {
        card.addEventListener("click", () => {
          if (selectedWechatTheme === card.dataset.selectTheme) return;
          // update selected state without full rebuild
          const prev = $("themeList").querySelector(".theme-card.selected");
          if (prev) {
            prev.classList.remove("selected");
            const prevCheck = prev.querySelector(".theme-check");
            if (prevCheck) prevCheck.remove();
          }
          selectedWechatTheme = card.dataset.selectTheme;
          card.classList.add("selected");
          // add checkmark if not present
          if (!card.querySelector(".theme-check")) {
            const check = document.createElement("span");
            check.className = "theme-check";
            check.textContent = "✓";
            card.querySelector(".theme-card-body")?.appendChild(check);
          }
        });
      });
      $("themeList").querySelectorAll("[data-favorite-theme]").forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const themeId = btn.dataset.favoriteTheme;
          // toggle fav state directly on the DOM
          const wasOn = btn.classList.contains("on");
          if (wasOn) {
            btn.classList.remove("on");
            btn.textContent = "☆";
            btn.title = "收藏风格";
            btn.setAttribute("aria-label", "收藏风格");
          } else {
            btn.classList.add("on");
            btn.textContent = "★";
            btn.title = "取消收藏";
            btn.setAttribute("aria-label", "取消收藏");
          }
          // persist to localStorage
          if (wasOn) {
            favoriteThemes = favoriteThemes.filter((item) => item !== themeId);
          } else {
            favoriteThemes = [themeId, ...favoriteThemes];
          }
          writeFavoriteThemes();
        });
      });
    }

    function renderThemeList() {
      const q = $("themeSearch").value.trim().toLowerCase();
      const matches = wechatThemes.filter((theme) => {
        const blob = [theme.id, theme.name, theme.description].join(" ").toLowerCase();
        return !q || blob.includes(q);
      });
      const favoriteSet = new Set(favoriteThemes);
      const favorites = favoriteThemes.map(themeById).filter(Boolean).filter((theme) => matches.some((item) => item.id === theme.id));
      const rest = matches.filter((theme) => !favoriteSet.has(theme.id));
      $("themeList").innerHTML = matches.length === 0
        ? '<div class="theme-empty">没有匹配的风格。</div>'
        : themeSection("收藏", favorites) + themeSection("全部风格", rest);
      bindThemeListEvents();
    }

    async function submitThemeModal() {
      if (!themeModalVideoId) return;
      const videoId = themeModalVideoId;
      const theme = selectedWechatTheme;
      closeThemeModal();
      await formatWechat(videoId, theme);
    }

    async function formatWechat(videoId, theme) {
      toast("开始排版公众号主稿...");
      const resp = await fetch("/api/wechat-format", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, theme }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        toast(payload.error || "排版失败");
        await load();
        return;
      }
      toast("公众号排版完成");
      await load();
    }

    async function copyWechatHtml(videoId) {
      const resp = await fetch("/api/wechat-format/file?videoId=" + encodeURIComponent(videoId) + "&kind=html");
      if (!resp.ok) {
        toast("没有可复制的 HTML");
        return;
      }
      await navigator.clipboard.writeText(await resp.text());
      toast("已复制 HTML");
    }

    function render() {
      const videos = filteredVideos();
      renderSummary(videos);
      renderRows(videos);
      renderDetail();
    }

    $("refresh").addEventListener("click", load);
    $("search").addEventListener("input", render);
    $("platformFilter").addEventListener("change", render);
    $("statusFilter").addEventListener("change", render);
    $("themeModalClose").addEventListener("click", closeThemeModal);
    $("themeModalCancel").addEventListener("click", closeThemeModal);
    $("themeModalSubmit").addEventListener("click", submitThemeModal);
    $("themeSearch").addEventListener("input", renderThemeList);
    $("themeModal").addEventListener("click", (event) => {
      if (event.target === $("themeModal")) closeThemeModal();
    });
    Promise.all([loadWechatThemes(), load()]).catch((err) => {
      $("rows").innerHTML = '<tr><td colspan="6">加载失败：' + esc(err.message) + '</td></tr>';
    });`;
