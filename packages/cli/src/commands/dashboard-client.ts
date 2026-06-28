export const DASHBOARD_CLIENT = String.raw`    const platformLabels = { x: "X", xiaohongshu: "小红书", wechat: "公众号", bilibili: "B站" };
    const platformOrder = ["x", "xiaohongshu", "wechat", "bilibili"];
    let payload = null;
    let selectedId = localStorage.getItem("yt2x.selectedVideoId");
    let wechatThemes = [];
    let themeModalVideoId = null;
    let selectedWechatTheme = "github";
    let favoriteThemes = [];
    let sortField = "originalDate";
    let sortDir = -1; // -1 = desc, 1 = asc, 0 = none
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

    var loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      var refreshBtn = $("refresh");
      if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = "…"; }
      try {
        const resp = await fetch("/api/videos");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        payload = await resp.json();
        if (selectedId && !payload.videos.some((v) => v.videoId === selectedId)) selectedId = null;
        if (!selectedId && payload.videos.length > 0) selectedId = payload.videos[0].videoId;
        $("sourceLine").textContent = payload.videos.length + " 个视频 · 本地内容库";
        render();
      } catch (err) {
        $("rows").innerHTML = '<tr><td colspan="8" style="color:var(--accent-2);padding:24px">加载失败：' + esc(err.message) + '。请检查后端服务是否正常。</td></tr>';
      }
      loading = false;
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = "刷新"; }
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
      const needsAction = $("needsActionFilter").classList.contains("on");
      let list = payload.videos.filter((video) => {
        const blob = [
          video.videoId,
          video.title,
          ...platformOrder.flatMap((p) => [video.platforms[p].url, video.platforms[p].note, video.platforms[p].files.join(" ")])
        ].join("\n").toLowerCase();
        if (q && !blob.includes(q)) return false;
        if (needsAction) { var scope = platform === "all" ? platformOrder : [platform]; return scope.some((p) => (video.platforms[p].generated && !video.platforms[p].published) || video.platforms[p].status === "failed"); }
        const platforms = platform === "all" ? platformOrder : [platform];
        if (status === "generated" && !platforms.some((p) => video.platforms[p].status !== "empty")) return false;
        if (status === "published" && !platforms.some((p) => video.platforms[p].status === "published")) return false;
        if (status === "unpublished" && !platforms.some((p) => video.platforms[p].status !== "empty" && video.platforms[p].status !== "published")) return false;
        return true;
      });
      if (sortDir !== 0 && sortField) {
        list = list.sort((a, b) => {
          const va = a[sortField] ?? "";
          const vb = b[sortField] ?? "";
          return sortDir * va.localeCompare(vb);
        });
      }
      return list;
    }

    function renderSummary(videos) {
      const total = videos.length;
      const totalTasks = total * 4; // 4 platforms per video
      const published = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].published).length, 0);
      const failed = videos.reduce((sum, v) => sum + platformOrder.filter((p) => v.platforms[p].status === "failed" && !v.platforms[p].generated).length, 0);
      const needsAction = videos.reduce((sum, v) => sum + platformOrder.filter((p) => (v.platforms[p].generated && !v.platforms[p].published) || v.platforms[p].status === "failed").length, 0);
      $("summary").innerHTML = [
        '<div class="metric-group"><div class="metric-group-label">内容库</div>',
        '<div class="metric"><b>' + total + '</b><span>视频</span></div></div>',
        '<div class="metric-sep"></div>',
        '<div class="metric-group"><div class="metric-group-label">发布进度</div>',
        '<div class="metric"><b>' + published + '</b><span>已发布</span></div>',
        '<div class="metric"><b>' + needsAction + '</b><span>需处理</span></div></div>',
      ].join("");
    }

    const statusLabels = { empty: "无稿件", draft: "待排版", formatted: "已排版", published: "已发布", failed: "排版失败" };
    function platformPill(state) {
      var st = state.status || "empty";
      if (st === "empty") return '<span class="pill pill-empty">—</span>';
      if (st === "failed") return '<span class="pill pill-failed pill-strong">排版失败</span>';
      var cls = "pill pill-" + st;
      if (st === "draft") cls += " pill-pulse";
      return '<span class="' + cls + '">' + (statusLabels[st] || st) + '</span>';
    }

    function selectVideo(videoId) {
      if (selectedId === videoId) return;
      const prev = document.querySelector("tr.active");
      if (prev) prev.classList.remove("active");
      selectedId = videoId;
      localStorage.setItem("yt2x.selectedVideoId", videoId);
      const next = document.querySelector('tr[data-id="' + CSS.escape(videoId) + '"]');
      if (next) next.classList.add("active");
      renderDetail(false); // different video → reset scroll
    }

    function renderRows(videos) {
      $("rows").innerHTML = videos.map((video) => [
        '<tr tabindex="0" class="' + (video.videoId === selectedId ? "active" : "") + '" data-id="' + esc(video.videoId) + '">',
        '<td><div class="title">' + esc(video.title) + '</div>' +
          '<div class="video-id" title="点击复制" onclick="event.stopPropagation();navigator.clipboard.writeText(\'' + esc(video.videoId) + '\');this.classList.add(\'copied\');setTimeout(()=>this.classList.remove(\'copied\'),1500)">' + esc(video.videoId) + '</div></td>',
        '<td class="date">' + esc(fmtDate(video.originalDate || video.updatedAt)) + '</td>',
        '<td class="date">' + esc(fmtDate(video.uploadDate)) + '</td>',
        '<td class="date">' + esc(fmtDate(video.updatedAt)) + '</td>',
        platformOrder.map((p) => '<td class="platform-cell">' + platformPill(video.platforms[p]) + '</td>').join(""),
        '</tr>',
      ].join("")).join("");
      document.querySelectorAll("tr[data-id]").forEach((row) => {
        row.addEventListener("click", function() { selectVideo(row.dataset.id); });
        row.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectVideo(row.dataset.id); }
        });
      });
      // Mobile card list
      renderMobileCards(videos);
    }

    function renderMobileCards(videos) {
      var container = document.getElementById("mobileCards");
      if (!container) { var mc = document.createElement("div"); mc.className = "mobile-cards"; mc.id = "mobileCards"; var tw = document.querySelector(".table-wrap"); if (tw) tw.appendChild(mc); container = mc; }
      if (!container) return;
      container.innerHTML = videos.map(function(v) {
        return '<div class="mobile-card' + (v.videoId === selectedId ? " active" : "") + '" data-id="' + esc(v.videoId) + '">' +
          '<div class="mc-title">' + esc(v.title) + '</div>' +
          '<div class="mc-pills">' + platformOrder.map(function(p) { return platformPill(v.platforms[p]); }).join("") + '</div>' +
          '<div class="mc-date">' + esc(fmtDate(v.updatedAt)) + '</div>' +
          '</div>';
      }).join("");
      container.querySelectorAll(".mobile-card").forEach(function(card) {
        card.addEventListener("click", function() { selectVideo(card.dataset.id); });
      });
    }

    // ── Mobile drawer ──
    function openDrawer() { $("drawerOverlay").classList.add("open"); }
    function closeDrawer() { $("drawerOverlay").classList.remove("open"); }
    $("drawerOverlay").addEventListener("click", function(e) { if (e.target === $("drawerOverlay")) closeDrawer(); });
    $("drawerClose").addEventListener("click", closeDrawer);

    // on mobile, render detail into drawer instead of aside
    var origRenderDetail = renderDetail;
    renderDetail = function(keepScroll) {
      if (window.innerWidth <= 860) {
        // Mobile: render into drawer
        var video = payload.videos.find(function(item) { return item.videoId === selectedId; });
        if (!video) return;
        var html = '<h2 class="detail-title">' + esc(video.title) + '</h2>' +
          (video.originalTitle ? '<div class="detail-original-title">' + esc(video.originalTitle) + '</div>' : "") +
          '<div class="detail-meta">' + esc(video.articleDir || "无 article 目录") + '</div>' +
          platformOrder.map(function(p) { return renderPlatformCard(video, p); }).join("");
        $("drawerContent").innerHTML = html;
        bindDetailEvents(video);
        openDrawer();
      } else {
        origRenderDetail(keepScroll);
      }
    };

    function bindDetailEvents(video) {
      var el = $("drawerContent");
      el.querySelectorAll("[data-publish]").forEach(function(btn) { btn.addEventListener("click", function() { publishPlatform(video.videoId, btn.dataset.publish); }); });
      el.querySelectorAll("[data-unpublish]").forEach(function(btn) { btn.addEventListener("click", function() { unpublishPlatform(video.videoId, btn.dataset.unpublish); }); });
      el.querySelectorAll("[data-copy]").forEach(function(btn) { btn.addEventListener("click", function() { copyPlatform(video.videoId, btn.dataset.copy); }); });
      el.querySelectorAll("[data-format-wechat]").forEach(function(btn) { btn.addEventListener("click", function() { openThemeModal(video.videoId, btn.dataset.theme || "github"); }); });
      el.querySelectorAll("[data-format-wechat-x-images]").forEach(function(btn) { btn.addEventListener("click", function() { formatWechatWithXImages(video.videoId, btn.dataset.theme || "github"); }); });
      el.querySelectorAll("[data-copy-wechat-html]").forEach(function(btn) { btn.addEventListener("click", function() { copyWechatHtml(video.videoId); }); });
      el.querySelectorAll("[data-format-platform]").forEach(function(btn) { btn.addEventListener("click", function() { formatPlatform(video.videoId, btn.dataset.formatPlatform); }); });
      el.querySelectorAll("[data-generate-platform]").forEach(function(btn) { btn.addEventListener("click", function() { generatePlatform(video.videoId, btn.dataset.generatePlatform); }); });
      el.querySelectorAll("[data-init-platform]").forEach(function(btn) { btn.addEventListener("click", function() { initPlatform(video.videoId, btn.dataset.initPlatform); }); });
      el.querySelectorAll("[data-more]").forEach(function(btn) { btn.addEventListener("click", function(e) { e.stopPropagation(); toggleMoreMenu(btn.dataset.more); }); });
    }

    function swapDetailHTML(html, keepScroll) {
      const detail = $("detail");
      const scrollTop = keepScroll ? detail.scrollTop : 0;
      const template = document.createElement("template");
      template.innerHTML = html;
      detail.replaceChildren(template.content);
      detail.scrollTop = scrollTop;
    }

    function renderDetail(keepScroll) {
      const video = payload.videos.find((item) => item.videoId === selectedId);
      if (!video) {
        swapDetailHTML('<div class="empty">没有匹配的视频。</div>', false);
        return;
      }
      const html = [
        '<h2 class="detail-title">' + esc(video.title) + '</h2>',
        video.originalTitle ? '<div class="detail-original-title">' + esc(video.originalTitle) + '</div>' : "",
        '<div class="detail-meta">' + esc(video.articleDir || "无 article 目录") + '</div>',
        platformOrder.map((p) => renderPlatformCard(video, p)).join(""),
      ].join("");
      swapDetailHTML(html, keepScroll === true);
      var detail = $("detail");
      detail.querySelectorAll("[data-publish]").forEach(function(btn) {
        btn.addEventListener("click", function() { publishPlatform(video.videoId, btn.dataset.publish); });
      });
      detail.querySelectorAll("[data-unpublish]").forEach(function(btn) {
        btn.addEventListener("click", function() { unpublishPlatform(video.videoId, btn.dataset.unpublish); });
      });
      detail.querySelectorAll("[data-copy]").forEach(function(btn) {
        btn.addEventListener("click", function() { copyPlatform(video.videoId, btn.dataset.copy); });
      });
      detail.querySelectorAll("[data-format-wechat]").forEach(function(btn) {
        btn.addEventListener("click", function() { openThemeModal(video.videoId, btn.dataset.theme || "github"); });
      });
      detail.querySelectorAll("[data-format-wechat-x-images]").forEach(function(btn) {
        btn.addEventListener("click", function() { formatWechatWithXImages(video.videoId, btn.dataset.theme || "github"); });
      });
      detail.querySelectorAll("[data-copy-wechat-html]").forEach(function(btn) {
        btn.addEventListener("click", function() { copyWechatHtml(video.videoId); });
      });
      detail.querySelectorAll("[data-format-platform]").forEach(function(btn) {
        btn.addEventListener("click", function() { formatPlatform(video.videoId, btn.dataset.formatPlatform); });
      });
      detail.querySelectorAll("[data-generate-platform]").forEach(function(btn) {
        btn.addEventListener("click", function() { generatePlatform(video.videoId, btn.dataset.generatePlatform); });
      });
      detail.querySelectorAll("[data-init-platform]").forEach(function(btn) {
        btn.addEventListener("click", function() { initPlatform(video.videoId, btn.dataset.initPlatform); });
      });
      detail.querySelectorAll("[data-more]").forEach(function(btn) {
        btn.addEventListener("click", function(e) { e.stopPropagation(); toggleMoreMenu(btn.dataset.more); });
      });
    }

    const generatingSet = new Set();
    async function generatePlatform(videoId, platform) {
      if (generatingSet.has(videoId + ":" + platform)) return;
      generatingSet.add(videoId + ":" + platform);
      var btn = document.querySelector('[data-generate-platform="' + platform + '"]');
      if (btn) { btn.disabled = true; btn.classList.add("loading"); btn.innerHTML = '生成中<span class="dots"><span>.</span><span>.</span><span>.</span></span>'; }
      try {
        const resp = await fetch("/api/platform-generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videoId, platform }),
        });
        if (!resp.ok) { const data = await resp.json().catch(function() { return {}; }); toast(data.error || "生成失败"); }
        else { toast((platformLabels[platform] || platform) + "稿件已生成"); }
      } catch { toast("生成请求失败"); }
      generatingSet.delete(videoId + ":" + platform);
      await load();
    }

    const formattingSet = new Set();
    async function formatPlatform(videoId, platform) {
      if (formattingSet.has(videoId + ":" + platform)) return;
      formattingSet.add(videoId + ":" + platform);
      // Disable only this platform's format button
      var btn = document.querySelector('[data-format-platform="' + platform + '"]');
      if (btn) { btn.disabled = true; btn.classList.add("loading"); btn.innerHTML = '排版中<span class="dots"><span>.</span><span>.</span><span>.</span></span>'; }
      // Pass theme from data-theme (used by WeChat for theme selection)
      var _theme = btn ? btn.dataset.theme || "github" : "github";
      try {
        const resp = await fetch("/api/platform-format", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videoId, platform, theme: _theme }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          toast(data.error || "排版失败");
        } else {
          toast((platformLabels[platform] || platform) + "排版完成");
        }
      } catch {
        toast("排版请求失败");
      }
      formattingSet.delete(videoId + ":" + platform);
      await load();
    }

    // ── Confirm dialog (#3) ──
    let confirmResolve = null;
    function showConfirm(html, okText, variant) {
      $("confirmBody").innerHTML = html;
      var okBtn = $("confirmOk");
      okBtn.textContent = okText || "确认";
      okBtn.className = variant === "danger" ? "danger-btn" : variant === "primary" ? "primary-btn" : "secondary";
      $("confirmDialog").classList.add("open");
      okBtn.focus();
      return new Promise(function(resolve) { confirmResolve = resolve; });
    }
    function hideConfirm(result) {
      $("confirmDialog").classList.remove("open");
      if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
    }
    $("confirmCancel").addEventListener("click", function() { hideConfirm(false); });
    $("confirmOk").addEventListener("click", function() { hideConfirm(true); });
    $("confirmDialog").addEventListener("click", function(e) {
      if (e.target === $("confirmDialog")) hideConfirm(false);
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape" && $("confirmDialog").classList.contains("open")) hideConfirm(false);
    });

    async function initPlatform(videoId, platform) {
      const platformName = platformLabels[platform] || platform;
      var extraFiles = "";
      if (platform === "xiaohongshu" || platform === "bilibili") {
        extraFiles = "<div class='confirm-item'>" + platform + "-article.md（平台文章）</div>" +
          "<div class='confirm-item'>" + platform + "-metadata.json（平台元数据）</div>";
      }
      const ok = await showConfirm(
        "<div class='confirm-icon'>🗑</div>" +
        "<div class='confirm-title'>删除" + platformName + "排版产出</div>" +
        "<div class='confirm-sub'>以下内容将被永久删除：</div>" +
        "<div class='confirm-list'>" +
        "<div class='confirm-item'>" + platform + "-format/ 目录（排版 HTML、prompts、图片等）</div>" +
        extraFiles +
        "</div>" +
        "<div class='confirm-warn'>此操作不可恢复。排版状态将被重置。</div>",
        "删除并重新初始化",
        "danger"
      );
      if (!ok) return;

      try {
        const resp = await fetch("/api/platform-init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videoId, platform }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(function() { return { error: "未知错误" }; });
          toast("初始化失败: " + (err.error || ""));
          return;
        }
        const data = await resp.json();
        toast("已初始化 " + platformName + "，删除了 " + (data.deleted || []).length + " 项");
      } catch {
        toast("初始化请求失败");
      }
      await load();
    }

    function renderPlatformCard(video, platform) {
      const state = video.platforms[platform];
      const st = state.status;
      const orchPreviewLink = '/api/platform-orchestrate/preview?videoId=' + encodeURIComponent(video.videoId) + '&platform=' + platform;
      const previewHref = st === "published" ? orchPreviewLink + '&mode=published' : orchPreviewLink;
      const pn = platformLabels[platform] || platform;

      // ── Workflow guidance line (#1) ──
      const guide = {
        empty: '<span class="guide-icon">📝</span> 点击生成' + pn + '稿件',
        draft: platform === "wechat"
          ? '<span class="guide-icon">🎨</span> 选择主题并排版'
          : '<span class="guide-icon">✨</span> 稿件就绪 · 点击排版',
        formatted: platform === "wechat"
          ? '<span class="guide-icon">📋</span> 复制 HTML 粘贴到公众号编辑器'
          : '<span class="guide-icon">👁</span> 预览排版 · 确认后发布',
        failed: '<span class="guide-icon">⚠️</span> 排版失败 · 查看原因并重试',
        published: '<span class="guide-icon">✅</span> 已发布' + (/^https?:\/\//i.test(state.url) ? ' · <a href="' + esc(state.url) + '" target="_blank" rel="noopener noreferrer" class="pub-link">查看</a>' : ''),
      };
      const guideLine = '<div class="guide-line guide-' + st + '">' + (guide[st] || '') + '</div>';

      // ── Progress dots (#1) ──
      const phases = ["empty", "draft", "formatted", "published"];
      const currentIdx = phases.indexOf(st);
      const dots = phases.map(function(p, i) {
        var c = "dot";
        if (i < currentIdx) c += " dot-done";
        else if (i === currentIdx) c += " dot-current";
        if (st === "failed" && i === phases.indexOf("formatted")) c += " dot-failed";
        return '<span class="' + c + '"></span>';
      }).join("");

      // ── Publish control (#2) ──
      var publishCtrl = "";
      if (st === "published") {
        publishCtrl = '<div class="publish-ctrl"><span class="pub-done">已发布 ✓</span><button class="ghost" data-unpublish="' + platform + '">撤销</button></div>';
      } else if (st === "formatted") {
        publishCtrl = '<div class="publish-ctrl"><button class="secondary" data-publish="' + platform + '">标记为已发布</button></div>';
      }

      // ── Primary action button ──
      var primaryBtn = "";
      if (st === "empty") {
        primaryBtn = '<button class="primary-btn" data-generate-platform="' + platform + '">生成' + pn + '稿</button>';
      } else if (st === "draft") {
        if (platform === "wechat") {
          primaryBtn = '<button class="primary-btn" data-format-wechat="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "github") + '">排版</button>';
        } else {
          primaryBtn = '<button class="primary-btn" data-format-platform="' + platform + '">排版</button>';
        }
      } else if (st === "formatted") {
        primaryBtn = ''; // no primary action — delivery + preview are the main actions
      } else if (st === "failed") {
        if (platform === "wechat") {
          primaryBtn = '<button class="primary-btn" data-format-wechat="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "github") + '">重试排版</button>';
        } else {
          primaryBtn = '<button class="primary-btn" data-format-platform="' + platform + '">重试排版</button>';
        }
      }

      // Error line
      const errorLine = st === "failed"
        ? '<div class="format-error">' + esc(state.formatError || "排版失败") + '</div>'
        : '';

      // ── Delivery action (per platform) ──
      var deliveryBtn = "";
      if (st !== "empty") {
        if (platform === "wechat" && (st === "formatted" || st === "published")) {
          deliveryBtn = '<button class="secondary" data-copy-wechat-html="' + esc(video.videoId) + '">复制 HTML</button>';
        } else if (platform !== "wechat") {
          deliveryBtn = '<button class="secondary" data-copy="' + platform + '">复制稿件</button>';
        }
      }

      // ── More menu ──
      var moreItems = [];
      if (st !== "empty") {
        moreItems.push('<a href="/api/file?videoId=' + encodeURIComponent(video.videoId) + '&platform=' + platform + '" target="_blank" rel="noopener noreferrer" class="more-item">打开稿件</a>');
      }
      if (st !== "empty" && platform === "wechat") {
        moreItems.push('<button class="more-item" data-format-wechat-x-images="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "github") + '">X配图排版</button>');
      }
      if (st === "formatted" || st === "failed") {
        if (platform === "wechat") {
          moreItems.push('<button class="more-item" data-format-wechat="' + esc(video.videoId) + '" data-theme="' + esc(state.formatTheme || "github") + '">重新排版</button>');
        } else {
          moreItems.push('<button class="more-item" data-format-platform="' + platform + '">重新排版</button>');
        }
      }
      if (st !== "published" && st !== "empty") {
        moreItems.push('<div class="more-sep"></div>');
        moreItems.push('<button class="danger-item" data-init-platform="' + platform + '">删除排版产出并重新初始化</button>');
      }
      var moreMenu = moreItems.length > 0
        ? '<div class="more-wrap"><button class="ghost more-trigger" data-more="' + platform + '" aria-label="更多操作">···</button><div class="more-drop" id="moreDrop-' + platform + '">' + moreItems.join("") + '</div></div>'
        : '';

      return [
        '<section class="platform-card">',
        '<div class="platform-head">',
        '<div class="platform-name">' + pn + ' <span class="progress-dots">' + dots + '</span></div>',
        publishCtrl,
        '</div>',
        guideLine,
        errorLine,
        '<input data-url="' + platform + '" placeholder="发布链接" value="' + esc(state.url) + '" />',
        '<textarea data-note="' + platform + '" placeholder="备注">' + esc(state.note) + '</textarea>',
        '<div class="actions">',
        '<div class="action-row">',
        primaryBtn,
        st !== "empty" ? '<a href="' + previewHref + '" target="_blank" rel="noopener noreferrer" class="btn-link secondary">预览</a>' : '',
        deliveryBtn,
        moreMenu,
        '</div>',
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
      if (!resp.ok) { toast("保存失败"); return; }
      toast("已保存");
      await load();
    }

    async function publishPlatform(videoId, platform) {
      var urlInput = document.querySelector('[data-url="' + platform + '"]');
      var url = urlInput ? urlInput.value.trim() : "";
      var noteInput = document.querySelector('[data-note="' + platform + '"]');
      var note = noteInput ? noteInput.value : "";
      var pn = platformLabels[platform] || platform;

      var ok = await showConfirm(
        "<div class='confirm-icon'>📮</div>" +
        "<div class='confirm-title'>确认" + pn + "已发布</div>" +
        "<div class='confirm-sub'>发布后可在平台卡片中查看链接、撤销状态。请填写公开访问链接。</div>" +
        "<div class='confirm-field'><label>发布链接 <span class='req'>*</span></label>" +
        "<input id='publishUrlInput' value='" + esc(url) + "' placeholder='https://...' autocomplete='off' /></div>",
        "确认发布",
        "primary"
      );
      if (!ok) return;

      url = (document.getElementById("publishUrlInput") ? document.getElementById("publishUrlInput").value : url).trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        toast("请输入有效的发布链接（以 http:// 或 https:// 开头）");
        return;
      }
      if (urlInput) urlInput.value = url;

      const resp = await fetch("/api/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, platform, published: true, url: url, note: note }),
      });
      if (!resp.ok) {
        var err = await resp.json().catch(function() { return { error: "保存失败" }; });
        toast(err.error || "保存失败");
        return;
      }
      toast(pn + " 已标记为已发布");
      await load();
    }

    async function unpublishPlatform(videoId, platform) {
      var pn = platformLabels[platform] || platform;
      var ok = await showConfirm(
        "<div class='confirm-icon'>↩</div>" +
        "<div class='confirm-title'>撤销" + pn + "发布</div>" +
        "<div class='confirm-sub'>该平台将回到「已排版」状态。发布链接和备注会被保留。</div>",
        "撤销发布",
        "secondary"
      );
      if (!ok) return;

      var urlInput = document.querySelector('[data-url="' + platform + '"]');
      var noteInput = document.querySelector('[data-note="' + platform + '"]');
      const resp = await fetch("/api/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId, platform, published: false, url: urlInput ? urlInput.value : "", note: noteInput ? noteInput.value : "" }),
      });
      if (!resp.ok) { toast("保存失败"); return; }
      toast(pn + " 已撤销发布");
      await load();
    }

    var morePortal = null;
    function closeMorePortal() { if (morePortal) { morePortal.remove(); morePortal = null; } }
    function toggleMoreMenu(platform) {
      var trigger = document.querySelector('[data-more="' + platform + '"]');
      if (!trigger) return;
      if (morePortal) { closeMorePortal(); return; }
      closeMorePortal();
      var drop = document.getElementById("moreDrop-" + platform);
      if (!drop) return;
      var rect = trigger.getBoundingClientRect();
      var portal = document.createElement("div");
      portal.className = "more-portal";
      portal.style.cssText = "position:fixed;z-index:200;visibility:hidden;top:0;right:" + (window.innerWidth - rect.right) + "px;";
      portal.innerHTML = drop.innerHTML;
      portal.addEventListener("click", function(e) { e.stopPropagation(); });
      document.body.appendChild(portal);
      // measure and flip direction
      var ph = portal.offsetHeight;
      var spaceBelow = window.innerHeight - rect.bottom - 8;
      var spaceAbove = rect.top - 8;
      var top;
      if (spaceBelow >= ph || spaceBelow >= spaceAbove) {
        top = rect.bottom + 4;
      } else {
        top = rect.top - ph - 4;
      }
      portal.style.top = top + "px";
      portal.style.visibility = "visible";
      // copy event handlers by delegating on the portal
      portal.querySelectorAll("[data-init-platform]").forEach(function(btn) {
        btn.addEventListener("click", function() { closeMorePortal(); initPlatform(payload.videos.find(function(v) { return v.videoId === selectedId; }).videoId, btn.dataset.initPlatform); });
      });
      portal.querySelectorAll("[data-format-wechat]").forEach(function(btn) {
        btn.addEventListener("click", function() { closeMorePortal(); var v = payload.videos.find(function(x) { return x.videoId === selectedId; }); if (v) openThemeModal(v.videoId, btn.dataset.theme); });
      });
      portal.querySelectorAll("[data-format-wechat-x-images]").forEach(function(btn) {
        btn.addEventListener("click", function() { closeMorePortal(); formatWechatWithXImages(selectedId, btn.dataset.theme || "github"); });
      });
      portal.querySelectorAll("[data-format-platform]").forEach(function(btn) {
        btn.addEventListener("click", function() { closeMorePortal(); formatPlatform(payload.videos.find(function(v) { return v.videoId === selectedId; }).videoId, btn.dataset.formatPlatform); });
      });
      portal.querySelectorAll("[data-copy]").forEach(function(btn) {
        btn.addEventListener("click", function() { closeMorePortal(); copyPlatform(payload.videos.find(function(v) { return v.videoId === selectedId; }).videoId, btn.dataset.copy); });
      });
      portal.querySelectorAll(".more-item:not([data-copy])").forEach(function(link) {
        // these are <a> links — they work natively
      });
      morePortal = portal;
      setTimeout(function() {
        document.addEventListener("click", function handler(e) {
          if (!portal.contains(e.target) && e.target !== trigger) { closeMorePortal(); document.removeEventListener("click", handler); }
        });
      }, 0);
    }
    document.addEventListener("click", function() { closeMorePortal(); });

    async function copyPlatform(videoId, platform) {
      const resp = await fetch("/api/file?videoId=" + encodeURIComponent(videoId) + "&platform=" + platform);
      if (!resp.ok) {
        toast("没有可复制的稿件");
        return;
      }
      await navigator.clipboard.writeText(await resp.text());
      toast("已复制稿件");
    }

    var lastFocusedBeforeModal = null;
    function openThemeModal(videoId, theme) {
      lastFocusedBeforeModal = document.activeElement;
      themeModalVideoId = videoId;
      selectedWechatTheme = theme || "github";
      $("themeSearch").value = "";
      renderThemeList();
      $("themeModal").classList.add("open");
      // focus first focusable element in modal
      setTimeout(function() { $("themeSearch").focus(); }, 50);
    }

    function closeThemeModal() {
      $("themeModal").classList.remove("open");
      themeModalVideoId = null;
      if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === "function") {
        setTimeout(function() { lastFocusedBeforeModal.focus(); }, 50);
      }
    }

    function themeById(themeId) {
      return wechatThemes.find((theme) => theme.id === themeId);
    }

    function themeCard(theme) {
      const favorite = isFavoriteTheme(theme.id);
      const selected = theme.id === selectedWechatTheme;
      var hash = 0;
      for (var i = 0; i < theme.id.length; i++) hash = ((hash << 5) - hash) + theme.id.charCodeAt(i);
      var h = Math.abs(hash);
      // Vary preview skeleton per theme: title width, body count, image position
      var tW = 50 + (h % 30); // title width 50-80%
      var bW = 70 + ((h >> 4) % 25); // body width 70-95%
      var b2 = (h >> 8) % 2; // second body line?
      var imgRight = (h >> 9) % 2; // image on right?
      var accentHue = h % 360;
      return [
        '<div class="theme-card' + (selected ? " selected" : "") + '" data-select-theme="' + esc(theme.id) + '" tabindex="0">',
        '<div class="theme-card-preview" style="--tcp-title-w:' + tW + '%;--tcp-body-w:' + bW + '%;--tcp-accent:' + accentHue + '">',
        '<div class="tcp-title" style="width:' + tW + '%"></div>',
        '<div class="tcp-body" style="width:' + bW + '%"></div>',
        b2 ? '<div class="tcp-body" style="width:' + (bW - 10) + '%"></div>' : '',
        imgRight ? '<div class="tcp-quote" style="width:' + (40 + (h % 20)) + '%"></div><div class="tcp-img"></div>' : '<div class="tcp-img"></div><div class="tcp-quote" style="width:' + (40 + (h % 20)) + '%"></div>',
        '</div>',
        '<button class="theme-fav' + (favorite ? " on" : "") + '" data-favorite-theme="' + esc(theme.id) + '" title="' + (favorite ? "取消收藏" : "收藏风格") + '" aria-label="' + (favorite ? "取消收藏" : "收藏风格") + '">' + (favorite ? "★" : "☆") + '</button>',
        '<div class="theme-card-body">',
        '<span class="theme-name">' + esc(theme.name || theme.id) + '</span>',
        '<span class="theme-id">' + esc(theme.id) + '</span>',
        theme.description ? '<span class="theme-desc">' + esc(theme.description) + '</span>' : "",
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
      function selectCard(card) {
        if (selectedWechatTheme === card.dataset.selectTheme) return;
        const prev = $("themeList").querySelector(".theme-card.selected");
        if (prev) { prev.classList.remove("selected"); var pc = prev.querySelector(".theme-check"); if (pc) pc.remove(); }
        selectedWechatTheme = card.dataset.selectTheme;
        card.classList.add("selected");
        if (!card.querySelector(".theme-check")) { var ck = document.createElement("span"); ck.className = "theme-check"; ck.textContent = "✓"; card.querySelector(".theme-card-body").appendChild(ck); }
      }
      $("themeList").querySelectorAll("[data-select-theme]").forEach((card) => {
        card.addEventListener("click", function() { selectCard(card); });
        card.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCard(card); }
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
      var lockKey = videoId + ":wechat";
      if (formattingSet.has(lockKey)) return;
      formattingSet.add(lockKey);
      toast("开始排版公众号主稿...");
      try {
        const resp = await fetch("/api/wechat-format", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videoId, theme }),
        });
        if (!resp.ok) {
          const payload = await resp.json().catch(() => ({}));
          toast(payload.error || "排版失败");
        } else {
          toast("公众号排版完成");
        }
      } catch {
        toast("排版请求失败");
      }
      formattingSet.delete(lockKey);
      await load();
    }

    async function formatWechatWithXImages(videoId, theme) {
      var lockKey = videoId + ":wechat-x";
      if (formattingSet.has(lockKey)) return;
      formattingSet.add(lockKey);
      toast("开始根据 X 配图排版公众号...");
      try {
        var resp = await fetch("/api/wechat-format", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videoId: videoId, theme: theme, useXImages: true }),
        });
        if (!resp.ok) {
          var payload = await resp.json().catch(function() { return {}; });
          toast(payload.error || "X配图排版失败");
        } else {
          toast("公众号X配图排版完成");
        }
      } catch (e) {
        toast("排版请求失败");
      }
      formattingSet.delete(lockKey);
      await load();
    }

    async function copyWechatHtml(videoId) {
      const resp = await fetch("/api/wechat-format/file?videoId=" + encodeURIComponent(videoId) + "&kind=html");
      if (!resp.ok) {
        toast("没有可复制的 HTML");
        return;
      }
      const html = await resp.text();
      try {
        // write as rich HTML so WeChat editor pastes rendered content (not raw code)
        const blob = new Blob([html], { type: "text/html" });
        const item = new ClipboardItem({ "text/html": blob });
        await navigator.clipboard.write([item]);
        toast("已复制 HTML");
      } catch {
        // fallback for browsers that don't support ClipboardItem
        await navigator.clipboard.writeText(html);
        toast("已复制 HTML（纯文本方式）");
      }
    }

    function syncHeaderHeight() {
      var h = document.querySelector("header");
      if (h) { var hh = h.offsetHeight; document.documentElement.style.setProperty("--header-real-h", hh + "px"); }
    }
    window.addEventListener("resize", syncHeaderHeight);
    syncHeaderHeight(); // set immediately before first render

    function render() {
      syncHeaderHeight();
      const videos = filteredVideos();
      renderSummary(videos);
      renderRows(videos);
      renderDetail(true);
    }

    // ── Keyboard support (#5) ──
    document.addEventListener("keydown", function(e) {
      // Escape closes theme modal
      if (e.key === "Escape" && $("themeModal").classList.contains("open") && !$("confirmDialog").classList.contains("open")) {
        closeThemeModal();
      }
      // Arrow keys navigate video list when table has focus
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement && document.activeElement.closest("tr[data-id]")) {
        e.preventDefault();
        var rows = Array.from(document.querySelectorAll("tr[data-id]"));
        var idx = rows.indexOf(document.activeElement.closest("tr[data-id]"));
        var next = e.key === "ArrowDown" ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
        if (rows[next]) { rows[next].focus(); selectVideo(rows[next].dataset.id); }
      }
    });
    // Focus trap for theme modal
    $("themeModal").addEventListener("keydown", function(e) {
      if (e.key === "Escape") { closeThemeModal(); e.stopPropagation(); return; }
      if (e.key !== "Tab") return;
      var modal = $("themeModal").querySelector(".theme-modal");
      if (!modal) return;
      var focusable = modal.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    $("refresh").addEventListener("click", load);
    $("search").addEventListener("input", render);
    $("platformFilter").addEventListener("change", render);
    $("statusFilter").addEventListener("change", function() { $("needsActionFilter").classList.remove("on"); render(); });
    $("needsActionFilter").addEventListener("click", function() {
      var btn = $("needsActionFilter");
      if (btn.classList.contains("on")) { btn.classList.remove("on"); $("statusFilter").value = "all"; }
      else { btn.classList.add("on"); $("statusFilter").value = "all"; }
      render();
    });
    $("themeModalClose").addEventListener("click", closeThemeModal);
    $("themeModalCancel").addEventListener("click", closeThemeModal);
    $("themeModalSubmit").addEventListener("click", submitThemeModal);
    $("themeSearch").addEventListener("input", renderThemeList);
    $("themeModal").addEventListener("click", (event) => {
      if (event.target === $("themeModal")) closeThemeModal();
    });
    // Sort click handler
    document.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (sortField === field) {
          sortDir = sortDir === -1 ? 1 : sortDir === 1 ? 0 : -1;
        } else {
          sortField = field;
          sortDir = -1;
        }
        render();
      });
    });
    // Update sort indicators
    function updateSortIndicators() {
      document.querySelectorAll("th.sortable").forEach((th) => {
        const field = th.dataset.sort;
        th.classList.remove("sort-asc", "sort-desc");
        if (field === sortField && sortDir !== 0) {
          th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
        }
      });
    }
    const origRender = render;
    render = function() { origRender(); updateSortIndicators(); };

    Promise.all([loadWechatThemes(), load()]).catch((err) => {
      $("rows").innerHTML = '<tr><td colspan="8">加载失败：' + esc(err.message) + '</td></tr>';
    });`;
