export const DASHBOARD_STYLE = String.raw`    :root {
      --ink: #202019;
      --muted: #68685f;
      --line: #dedbd0;
      --panel: #fbfaf5;
      --paper: #f3f0e6;
      --accent: #0e6f5c;
      --accent-2: #c7512f;
      --ok: #0d7a4f;
      --warn: #a84c25;
      --shadow: 0 16px 45px rgba(32, 32, 25, 0.08);
      --header-h: 82px;
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      padding-top: var(--header-real-h, 82px);
      background:
        linear-gradient(90deg, rgba(32,32,25,.045) 1px, transparent 1px) 0 0 / 28px 28px,
        linear-gradient(rgba(32,32,25,.035) 1px, transparent 1px) 0 0 / 28px 28px,
        var(--paper);
    }

    header {
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(251,250,245,.92);
      backdrop-filter: blur(10px);
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 5;
      flex-wrap: wrap;
    }
    header .filters {
      display: flex;
      gap: 6px;
      align-items: center;
      flex: 1;
      min-width: 0;
    }
    header .filters input { min-width: 150px; flex: 1; }
    header .filters select { min-width: 80px; }
    @media (max-width: 1060px) {
      header { flex-direction: column; align-items: stretch; gap: 8px; padding: 10px 14px; }
      header .filters { flex-wrap: wrap; }
      header .filters input { min-width: 120px; }
    }

    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 25px;
      letter-spacing: .01em;
    }

    .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .filters { display: grid; grid-template-columns: 1fr 160px 160px; gap: 10px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #fffdf8;
      color: var(--ink);
      border-radius: 6px;
      padding: 10px 11px;
      font: inherit;
      font-size: 13px;
    }
    select {
      appearance: none;
      padding-right: 34px;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 18px) 50%,
        calc(100% - 13px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    textarea { min-height: 74px; resize: vertical; }
    button {
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #fffdf8;
      border-radius: 6px;
      padding: 9px 11px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease, opacity .15s ease, box-shadow .15s ease;
    }
    button:hover { background: #3a3a30; border-color: #3a3a30; }
    button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
    button.secondary:hover { background: #f8f4eb; border-color: #c4b898; color: #3a3a2e; }
    button.loading { opacity: .7; cursor: wait; }
    button.loading:hover { background: var(--ink); border-color: var(--ink); }
    button:disabled:hover { background: var(--ink); border-color: var(--ink); }
    .dots span { animation: dotPulse 1.4s infinite; font-weight: 700; }
    .dots span:nth-child(2) { animation-delay: .2s; }
    .dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes dotPulse { 0%,80%,100% { opacity: 0; } 40% { opacity: 1; } }
    button.ghost { background: transparent; color: var(--muted); border-color: transparent; }
    button.ghost:hover { color: var(--ink); background: rgba(0,0,0,.04); }
    a.btn-link { display: inline-block; text-decoration: none; font-size: 13px; padding: 9px 13px; border-radius: 6px; cursor: pointer; line-height: normal; transition: background .15s ease, border-color .15s ease, color .15s ease; }
    a.btn-link.secondary { color: var(--ink); border: 1px solid var(--line); background: transparent; }
    a.btn-link.secondary:hover { background: #f8f4eb; color: #3a3a2e; border-color: #c4b898; }

    main {
      display: grid;
      grid-template-columns: minmax(760px, 1fr) 360px;
      min-height: calc(100vh - var(--header-real-h, var(--header-h)));
    }

    .table-wrap { padding: 22px 20px 28px; overflow: auto; }
    .summary {
      display: flex;
      align-items: stretch;
      gap: 0;
      margin-bottom: 14px;
      background: rgba(251,250,245,.82);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 4px;
    }
    .metric-group { display: flex; align-items: center; gap: 8px; padding: 4px 12px; }
    .metric-group-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }
    .metric {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .metric b { font-size: 20px; line-height: 1.1; font-family: Georgia, serif; }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric-sep { width: 1px; background: var(--line); margin: 4px 8px; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: rgba(251,250,245,.92);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      vertical-align: middle;
      font-size: 13px;
    }
    th {
      position: sticky;
      top: 0;
      background: #ede8da;
      z-index: 2;
      color: #48483f;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    th.sortable {
      cursor: pointer;
      user-select: none;
    }
    th.sortable:hover { color: #202019; }
    /* unsorted: faint diamond lozenge — same 7×7 footprint as sorted chevrons */
    th.sortable::after {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-left: 4px;
      border: 1.5px solid currentColor;
      transform: rotate(45deg) translateY(-1px);
      opacity: .18;
      vertical-align: middle;
      transition: opacity .25s ease, border-color .25s ease, transform .3s cubic-bezier(.34,1.56,.64,1);
    }
    th.sortable:hover::after { opacity: .35; }
    /* sorted desc: thin downward chevron — same footprint as diamond */
    th.sortable.sort-desc::after {
      width: 6px;
      height: 6px;
      border: solid var(--accent);
      border-width: 0 1.5px 1.5px 0;
      transform: rotate(45deg) translateY(-1px);
      opacity: 1;
    }
    /* sorted asc: thin upward chevron — same footprint as diamond */
    th.sortable.sort-asc::after {
      width: 6px;
      height: 6px;
      border: solid var(--accent);
      border-width: 0 1.5px 1.5px 0;
      transform: rotate(-135deg) translateY(-1px);
      opacity: 1;
    }
    tr { cursor: pointer; }
    tr:hover td { background: #fffdf8; }
    tr.active td { background: #e9f3ee; }
    .title { max-width: 430px; font-weight: 650; line-height: 1.35; }
    .original-title {
      max-width: 430px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
      margin-top: 2px;
    }
    .video-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #8d8b80;
      font-size: 11px;
      margin-top: 2px;
      cursor: pointer;
      transition: color .2s;
      display: inline-block;
      max-width: fit-content;
      padding: 1px 4px;
      border-radius: 3px;
    }
    .video-id:hover { color: #333; }
    .video-id::after { content: " 📋"; opacity: 0; transition: opacity .2s; font-size: 10px; }
    .video-id:hover::after { opacity: .5; }
    .video-id.copied { color: #0e6f5c; }
    .video-id.copied::after { content: " ✅ 已复制"; opacity: 1; }
    .date { color: var(--muted); white-space: nowrap; font-size: 12px; }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 58px;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #fffdf8;
    }
    .pill-empty { color: #d9d5c8; border-color: transparent; background: transparent; min-width: auto; padding: 3px 6px; }
    .pill-draft { color: var(--warn); border-color: #e3b49c; background: #fff3ec; }
    .pill-formatted { color: #0e6f5c; border-color: #9bcdb7; background: #edf8f2; }
    .pill-published { color: #1a6b4a; border-color: #6abf8b; background: #e2f5e8; font-weight: 650; }
    .pill-failed { color: #c7512f; border-color: #c7512f; background: #fff0ec; font-weight: 700; }
    .pill-strong { font-weight: 700; }
    @keyframes pillPulse { 0%,100% { opacity: 1; } 50% { opacity: .65; } }
    .pill-pulse { animation: pillPulse 2s ease-in-out infinite; }
    .platform-cell { min-width: 60px; }
    /* workflow guide line */
    .guide-line { font-size: 12px; padding: 4px 0; color: var(--muted); display: flex; align-items: center; gap: 6px; }
    .guide-icon { font-size: 14px; }
    .guide-draft, .guide-failed { color: var(--warn); font-weight: 600; }
    .guide-published { color: var(--ok); }
    .pub-link { color: var(--accent); font-size: 12px; }
    /* progress dots */
    .progress-dots { display: inline-flex; gap: 4px; margin-left: 4px; vertical-align: middle; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #d9d5c8; display: inline-block; }
    .dot-done { background: #8d8b80; }
    .dot-current { background: var(--ink); width: 7px; height: 7px; }
    .dot-failed { background: var(--accent-2); }
    .format-error { font-size: 11px; color: var(--accent-2); margin: 4px 0; background: #fff0ec; padding: 6px 10px; border-radius: 6px; }
    .primary-btn {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 6px;
      padding: 9px 14px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      font-weight: 600;
    }
    .primary-btn:hover { background: #0b5e4d; border-color: #0b5e4d; }

    aside {
      border-left: 1px solid var(--line);
      background: rgba(251,250,245,.86);
      padding: 18px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
    @keyframes detailEnter {
      from { opacity: 0.5; }
      to { opacity: 1; }
    }
    aside > * {
      animation: detailEnter 0.13s ease both;
    }
    .detail-title { font-family: Georgia, serif; font-size: 22px; line-height: 1.2; margin: 0 0 8px; }
    .detail-original-title { color: var(--muted); font-size: 12px; line-height: 1.35; margin: -2px 0 8px; }
    .detail-meta { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
    .platform-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffdf8;
      padding: 12px;
      margin-bottom: 10px;
    }
    .platform-card input,
    .platform-card textarea {
      display: block;
      margin-top: 8px;
    }
    .platform-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .platform-name { font-weight: 750; display: flex; align-items: center; gap: 6px; }
    .actions { display: flex; flex-direction: column; gap: 6px; margin: 9px 0; }
    .action-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .file-list { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .empty { color: var(--muted); padding: 32px; text-align: center; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
    }
    /* ═══════════════════════════════════════════
       THEME MODAL
       ═══════════════════════════════════════════ */

    .modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 32px;
      background: rgba(32, 32, 25, 0.55);
      backdrop-filter: blur(12px);
      animation: overlayIn 0.22s ease;
    }
    .modal-overlay.open { display: flex; }

    @keyframes overlayIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes modalIn {
      from { opacity: 0; transform: translateY(24px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .theme-modal {
      width: min(820px, 100%);
      max-height: min(780px, 86vh);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      overflow: hidden;
      border: 1px solid #d5cdb9;
      border-radius: 16px;
      background:
        linear-gradient(175deg, #fffef9 0%, #fefcf4 30%, #fbf8ed 100%);
      box-shadow:
        0 0 0 1px rgba(251, 250, 245, 0.5),
        0 40px 100px rgba(32, 32, 25, 0.28),
        0 8px 32px rgba(32, 32, 25, 0.1);
      animation: modalIn 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
    }

    .theme-modal-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 20px 24px 16px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #fefcf7 0%, #f9f5ea 100%);
    }

    .theme-modal-head .head-left {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }

    .theme-modal-icon {
      flex: 0 0 44px;
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #f7f3e8, #ede4d2);
      border: 1px solid #d5cdb9;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      color: var(--accent);
      box-shadow: 0 4px 12px rgba(14, 111, 92, 0.08);
    }

    .theme-modal-title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 21px;
      font-weight: 700;
      line-height: 1.2;
      color: var(--ink);
      letter-spacing: 0.01em;
    }

    .theme-modal-sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
      line-height: 1.4;
    }

    .theme-search-wrap {
      padding: 14px 24px;
      border-bottom: 1px solid var(--line);
      background: #fffef9;
    }

    .theme-search-wrap input {
      padding: 10px 14px 10px 38px;
      border-radius: 10px;
      border: 1px solid #d5cdb9;
      background: #fffef9 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%238d8b80' stroke-width='1.6'%3E%3Ccircle cx='7' cy='7' r='4.5'/%3E%3Cpath d='m11 11 3 3'/%3E%3C/svg%3E") 12px 50% no-repeat;
      font-size: 13px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .theme-search-wrap input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(14, 111, 92, 0.1);
    }

    .theme-list {
      overflow: auto;
      padding: 18px 24px 22px;
      background: linear-gradient(180deg, #fffef9 0%, #fdfaf2 100%);
    }

    .theme-section { margin-bottom: 22px; }

    .theme-section:last-child { margin-bottom: 0; }

    .theme-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #7b6f58;
      font-size: 10px;
      font-weight: 750;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }

    .theme-section-title::after {
      content: "";
      flex: 1;
      height: 1px;
      background: var(--line);
    }

    .theme-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 11px;
    }

    /* ═══════════════════════════════════════════
       THEME CARD — Letterpress Specimen
       ═══════════════════════════════════════════ */

    /* staggered entrance for cards */
    @keyframes cardEnter {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .theme-card {
      --card-hue: 40;
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 120px;
      border: 1px solid #e0dbcf;
      border-radius: 10px;
      background:
        linear-gradient(175deg, #fefdf9 0%, #faf7ef 40%, #f6f2e6 100%);
      text-align: left;
      color: var(--ink);
      cursor: pointer;
      overflow: hidden;
      transition:
        border-color 0.25s ease,
        box-shadow 0.3s ease,
        transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow:
        0 1px 2px rgba(32, 32, 25, 0.04),
        0 3px 6px rgba(32, 32, 25, 0.03);
      animation: cardEnter 0.4s ease both;
    }

    /* staggered delay — each row of cards enters after the previous */
    .theme-card:nth-child(1)  { animation-delay: 0.00s; }
    .theme-card:nth-child(2)  { animation-delay: 0.03s; }
    .theme-card:nth-child(3)  { animation-delay: 0.06s; }
    .theme-card:nth-child(4)  { animation-delay: 0.09s; }
    .theme-card:nth-child(5)  { animation-delay: 0.12s; }
    .theme-card:nth-child(6)  { animation-delay: 0.15s; }
    .theme-card:nth-child(7)  { animation-delay: 0.18s; }
    .theme-card:nth-child(8)  { animation-delay: 0.21s; }
    .theme-card:nth-child(n+9) { animation-delay: 0.24s; }

    /* ── mock preview strip ── */
    .theme-card-preview {
      height: 80px;
      flex-shrink: 0;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      overflow: hidden;
    }
    .tcp-title { height: 11px; background: hsl(var(--tcp-accent, 35), 15%, 68%); border-radius: 2px; }
    .tcp-body { height: 5px; background: #d9d5c8; border-radius: 2px; }
    .tcp-quote { height: 5px; background: #e8e3d4; border-radius: 2px; }
    .tcp-img { width: 30px; height: 22px; background: hsl(var(--tcp-accent, 35), 12%, 82%); border-radius: 3px; align-self: flex-end; }

    .theme-card:hover {
      border-color: #c8b98d;
      box-shadow:
        0 1px 2px rgba(32, 32, 25, 0.04),
        0 8px 24px rgba(32, 32, 25, 0.1),
        0 2px 6px rgba(32, 32, 25, 0.05);
      transform: translateY(-4px);
    }

    /* ── selected state ── */
    .theme-card.selected {
      border-color: var(--accent);
      background: linear-gradient(175deg, #f0f8f4 0%, #eaf5ef 40%, #e2f0e8 100%);
      box-shadow:
        0 0 0 3px rgba(14, 111, 92, 0.08),
        0 8px 28px rgba(14, 111, 92, 0.06);
    }

    .theme-card.selected .theme-card-preview {
      background: #eaf5ef;
      border-color: rgba(14, 111, 92, 0.15);
    }

    /* ── checkmark on selected card ── */
    .theme-check {
      position: absolute;
      bottom: 10px;
      right: 12px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 8px rgba(14, 111, 92, 0.2);
    }

    /* ── card body ── */
    .theme-card-body {
      flex: 1;
      padding: 14px 42px 16px 15px;
      display: flex;
      flex-direction: column;
    }

    .theme-name {
      display: block;
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-weight: 700;
      font-size: 15px;
      line-height: 1.2;
      color: #1e1e17;
      letter-spacing: 0.01em;
    }

    .theme-id {
      display: block;
      margin-top: 4px;
      color: #a09b88;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
      letter-spacing: 0.03em;
    }

    .theme-desc {
      display: block;
      margin-top: 7px;
      color: #6e6b5e;
      font-size: 11px;
      line-height: 1.45;
    }

    /* ── preview line ── */
    .theme-preview {
      margin-top: auto;
      padding-top: 9px;
      font-size: 11px;
      color: #8d8976;
      font-family: Georgia, "Times New Roman", "Songti SC", serif;
      font-style: italic;
      letter-spacing: 0.02em;
      line-height: 1.35;
      border-top: 1px dotted rgba(0,0,0,0.07);
    }

    /* ═══════════════════════════════════════════
       FAVORITE BUTTON
       ═══════════════════════════════════════════ */

    .theme-fav {
      position: absolute;
      top: 12px;
      right: 10px;
      width: 30px;
      height: 30px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid #d9cfa8;
      background: rgba(255, 253, 244, 0.85);
      color: #c4a83a;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      transition: all 0.22s ease;
      box-shadow: 0 1px 4px rgba(0,0,0,0.04);
      z-index: 2;
      backdrop-filter: blur(4px);
    }

    .theme-fav:hover {
      border-color: #c49d15;
      background: #fffdf2;
      color: #8a6500;
      box-shadow: 0 3px 14px rgba(121, 89, 0, 0.15);
      transform: scale(1.12);
    }

    .theme-fav.on {
      color: #fffef8;
      background: linear-gradient(145deg, #d4a61c, #b8890a);
      border-color: #9b7200;
      box-shadow: 0 3px 14px rgba(180, 130, 0, 0.22);
    }

    .theme-fav.on:hover {
      background: linear-gradient(145deg, #e0b224, #c4950e);
    }

    .theme-empty {
      color: var(--muted);
      text-align: center;
      padding: 48px 20px;
      border: 1.5px dashed #d5cdb9;
      border-radius: 12px;
      font-size: 13px;
      background: #fefdf8;
    }

    .theme-modal-foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 24px;
      border-top: 1px solid var(--line);
      background: linear-gradient(180deg, #f9f5ea 0%, #f7f3e8 100%);
    }

    .theme-modal-foot button {
      padding: 10px 22px;
      font-size: 14px;
      font-weight: 600;
    }

    #themeModalSubmit {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      box-shadow: 0 4px 16px rgba(14, 111, 92, 0.18);
    }

    #themeModalSubmit:hover {
      background: #0b5e4d;
      border-color: #0b5e4d;
      box-shadow: 0 6px 22px rgba(14, 111, 92, 0.28);
    }
    /* publish control */
    .publish-ctrl { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .pub-done { color: var(--ok); font-weight: 600; }
    /* confirm dialog */
    .confirm-dialog {
      max-width: 400px; width: 88vw;
      padding: 0;
      border-radius: 12px;
      overflow: hidden;
      background: #fffef9;
      border: 1px solid #d9d3c0;
      box-shadow:
        0 0 0 1px rgba(32,32,25,.04),
        0 2px 4px rgba(32,32,25,.03),
        0 12px 40px rgba(32,32,25,.12),
        0 4px 14px rgba(32,32,25,.05);
    }
    .confirm-body { padding: 28px 28px 0; }
    .confirm-icon {
      width: 44px; height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, #fef9f0, #f9f0e0);
      border: 1.5px solid #e8dcc8;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
      margin-bottom: 16px;
    }
    .confirm-title {
      font-family: Georgia, 'Noto Serif SC', 'Songti SC', serif;
      font-size: 18px; font-weight: 700;
      color: var(--ink);
      margin-bottom: 6px;
      letter-spacing: .01em;
      line-height: 1.3;
    }
    .confirm-sub {
      font-size: 12px; color: var(--muted);
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .confirm-field {
      margin-bottom: 18px;
    }
    .confirm-field label {
      display: block;
      font-size: 11px;
      font-weight: 650;
      color: #5c584e;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 6px;
    }
    .confirm-field label .req { color: var(--accent-2); margin-left: 2px; }
    .confirm-field input {
      width: 100%; box-sizing: border-box;
      padding: 10px 12px;
      font-size: 13px;
      border: 1.5px solid #dad4c4;
      border-radius: 7px;
      background: #fefcf7;
      color: var(--ink);
      transition: border-color .15s ease, box-shadow .15s ease;
      font-family: inherit;
    }
    .confirm-field input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(14,111,92,.08);
      background: #fff;
    }
    .confirm-field input::placeholder { color: #bfb8a8; }
    .confirm-list {
      background: linear-gradient(175deg, #fdfaf2, #f9f3e4);
      border: 1px solid #e8dcc8;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .confirm-item {
      font-size: 12px; color: #6b655a;
      padding: 3px 0; padding-left: 16px;
      position: relative;
      line-height: 1.5;
    }
    .confirm-item::before {
      content: "";
      position: absolute; left: 0; top: 9px;
      width: 5px; height: 5px;
      border-radius: 50%;
      background: #d4c8ac;
    }
    .confirm-warn {
      font-size: 12px; color: var(--accent-2);
      font-weight: 650;
      padding: 10px 14px;
      background: linear-gradient(135deg, #fef7f3, #fef0eb);
      border: 1px solid #f0d4c8;
      border-radius: 7px;
      margin-bottom: 4px;
      display: flex; align-items: center; gap: 7px;
      line-height: 1.4;
    }
    .confirm-warn::before { content: "⚠"; font-size: 13px; flex-shrink: 0; }
    .confirm-foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 16px 24px;
      background: linear-gradient(180deg, transparent, #fefcf6 30%);
      border-top: 1px solid #ede6d4;
    }
    .confirm-foot button { padding: 8px 22px; font-size: 13px; border-radius: 7px; }
    .confirm-foot .secondary {
      background: transparent; color: var(--muted); border: 1.5px solid #d9d3c0;
    }
    .confirm-foot .secondary:hover { background: #f8f4eb; color: #4a453a; border-color: #c4b898; }
    .danger-btn {
      background: linear-gradient(180deg, #d44d2a, #c23f1c);
      color: #fff; border: none; font-weight: 650;
      box-shadow: 0 2px 8px rgba(196,60,28,.18), 0 1px 2px rgba(196,60,28,.08);
    }
    .danger-btn:hover { background: linear-gradient(180deg, #c23f1c, #a83d22); box-shadow: 0 4px 14px rgba(196,60,28,.25); }
    .confirm-foot .primary-btn {
      background: linear-gradient(180deg, #107d67, #0b6a56);
      color: #fff; border: none; font-weight: 650;
      box-shadow: 0 2px 8px rgba(14,111,92,.18), 0 1px 2px rgba(14,111,92,.08);
    }
    .confirm-foot .primary-btn:hover { background: linear-gradient(180deg, #0b6a56, #095a48); box-shadow: 0 4px 14px rgba(14,111,92,.25); }
    .confirm-esc-hint { font-size: 10px; color: #bfb8a8; text-align: right; padding: 0 28px 8px; }
    /* more menu */
    .more-wrap { position: relative; display: inline-block; }
    .more-trigger { font-size: 13px; letter-spacing: 2px; padding: 9px 8px; }
    .more-drop { display: none; }
    .more-portal {
      background: #fffdf8; border: 1px solid #d9d3c0; border-radius: 8px;
      box-shadow: 0 4px 24px rgba(32,32,25,.14), 0 1px 3px rgba(32,32,25,.06);
      min-width: 200px; padding: 6px 0;
      animation: dropIn .12s ease;
    }
    @keyframes dropIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .more-item { display: block; width: 100%; background: none; border: none; color: var(--ink); font-size: 12px; padding: 7px 14px; cursor: pointer; text-align: left; text-decoration: none; }
    .more-item:hover { background: #f8f4eb; }
    .more-sep { height: 1px; background: var(--line); margin: 4px 8px; }
    .danger-item { display: block; width: 100%; background: none; border: none; color: var(--accent-2); font-size: 12px; padding: 8px 14px; cursor: pointer; text-align: left; }
    .danger-item:hover { background: #fff0ec; }
    /* table row focus */
    tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

    .toast {
      position: fixed;
      right: 20px;
      bottom: 20px;
      background: var(--ink);
      color: #fffdf8;
      padding: 10px 12px;
      border-radius: 7px;
      opacity: 0;
      transform: translateY(8px);
      transition: .18s ease;
      pointer-events: none;
      z-index: 20;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    /* ── mobile card list ── */
    .mobile-cards { display: none; }
    @media (max-width: 860px) {
      .table-wrap table { display: none; }
      .mobile-cards { display: flex; flex-direction: column; gap: 6px; }
      .mobile-card { background: rgba(251,250,245,.88); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; cursor: pointer; }
      .mobile-card:active { background: #e9f3ee; }
      .mobile-card .mc-title { font-weight: 650; font-size: 13px; margin-bottom: 6px; line-height: 1.3; }
      .mobile-card .mc-pills { display: flex; gap: 8px; }
      .mobile-card .mc-date { font-size: 11px; color: var(--muted); margin-top: 4px; }
    }

    /* ── mobile drawer ── */
    .drawer-overlay { display: none; }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; }
      aside { display: none; }
      .drawer-overlay {
        display: none;
        position: fixed; inset: 0; z-index: 50;
        background: rgba(32,32,25,.35);
        backdrop-filter: blur(4px);
      }
      .drawer-overlay.open { display: flex; align-items: flex-end; }
      .drawer-sheet {
        background: #fefcf7;
        border-radius: 16px 16px 0 0;
        max-height: 85vh;
        width: 100%;
        overflow-y: auto;
        padding: 20px 16px 32px;
        box-shadow: 0 -8px 40px rgba(32,32,25,.12);
        animation: sheetUp .25s ease;
      }
      @keyframes sheetUp { from { transform: translateY(30%); } to { transform: translateY(0); } }
      .drawer-handle { width: 40px; height: 4px; background: #d9d5c8; border-radius: 2px; margin: 0 auto 16px; }
      .drawer-close { position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; color: var(--muted); cursor: pointer; padding: 4px 8px; }
    }

    @media (max-width: 860px) {
      th { top: 0; }
    }`;
