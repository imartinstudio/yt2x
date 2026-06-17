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
      background:
        linear-gradient(90deg, rgba(32,32,25,.045) 1px, transparent 1px) 0 0 / 28px 28px,
        linear-gradient(rgba(32,32,25,.035) 1px, transparent 1px) 0 0 / 28px 28px,
        var(--paper);
    }

    header {
      min-height: var(--header-h);
      padding: 18px 24px;
      display: grid;
      grid-template-columns: 280px 1fr auto;
      align-items: end;
      gap: 22px;
      border-bottom: 1px solid var(--line);
      background: rgba(251,250,245,.9);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 5;
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
    }
    button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
    button.loading { opacity: .7; cursor: wait; }
    .dots span { animation: dotPulse 1.4s infinite; font-weight: 700; }
    .dots span:nth-child(2) { animation-delay: .2s; }
    .dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes dotPulse { 0%,80%,100% { opacity: 0; } 40% { opacity: 1; } }
    button.ghost { background: transparent; color: var(--muted); border-color: transparent; padding: 6px 7px; }

    main {
      display: grid;
      grid-template-columns: minmax(760px, 1fr) 360px;
      min-height: calc(100vh - var(--header-h));
    }

    .table-wrap { padding: 22px 20px 28px; overflow: auto; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric {
      background: rgba(251,250,245,.82);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .metric b { display: block; font-size: 22px; line-height: 1.1; font-family: Georgia, serif; }
    .metric span { color: var(--muted); font-size: 12px; }

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
      top: var(--header-h);
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
    .pill.generated { color: var(--warn); border-color: #e3b49c; background: #fff3ec; }
    .pill.published { color: var(--ok); border-color: #9bcdb7; background: #edf8f2; }
    .platform-cell { min-width: 74px; }

    aside {
      border-left: 1px solid var(--line);
      background: rgba(251,250,245,.86);
      padding: 18px;
      position: sticky;
      top: var(--header-h);
      height: calc(100vh - var(--header-h));
      overflow: auto;
      contain: layout style paint;
      transform: translateZ(0);
      will-change: transform;
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
    .platform-name { font-weight: 750; }
    .switch {
      display: inline-grid;
      grid-template-columns: 1fr 1fr;
      width: 128px;
      flex: 0 0 128px;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: #f7f3e8;
    }
    .switch button {
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--muted);
      padding: 6px 7px;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
    }
    .switch button.on {
      background: var(--accent);
      color: #fff;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 9px 0; }
    .file-list { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .empty { color: var(--muted); padding: 32px; text-align: center; }
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

    /* ── ink swatch strip ── */
    .theme-card-ink {
      height: 6px;
      flex-shrink: 0;
      background: hsl(var(--card-hue), 28%, 72%);
      position: relative;
      transition: height 0.25s ease, background 0.25s ease;
    }

    /* subtle ink-bleed texture on the swatch */
    .theme-card-ink::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg,
          transparent 0%,
          rgba(255,255,255,0.3) 30%,
          transparent 50%,
          rgba(0,0,0,0.08) 70%,
          transparent 100%);
      opacity: 0.6;
    }

    .theme-card:hover {
      border-color: #c8b98d;
      box-shadow:
        0 1px 2px rgba(32, 32, 25, 0.04),
        0 8px 24px rgba(32, 32, 25, 0.1),
        0 2px 6px rgba(32, 32, 25, 0.05);
      transform: translateY(-4px);
    }

    .theme-card:hover .theme-card-ink {
      height: 8px;
    }

    /* ── selected state ── */
    .theme-card.selected {
      border-color: var(--accent);
      background: linear-gradient(175deg, #f0f8f4 0%, #eaf5ef 40%, #e2f0e8 100%);
      box-shadow:
        0 0 0 3px rgba(14, 111, 92, 0.08),
        0 8px 28px rgba(14, 111, 92, 0.06);
    }

    .theme-card.selected .theme-card-ink {
      background: var(--accent);
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

    @media (max-width: 1060px) {
      header { grid-template-columns: 1fr; height: auto; align-items: start; }
      .filters { grid-template-columns: 1fr; }
      main { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-left: 0; border-top: 1px solid var(--line); }
      th { top: 0; }
    }`;
