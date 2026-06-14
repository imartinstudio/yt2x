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
    }
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
    .modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 28px;
      background: rgba(32,32,25,.46);
      backdrop-filter: blur(7px);
    }
    .modal-overlay.open { display: flex; }
    .theme-modal {
      width: min(760px, 100%);
      max-height: min(760px, 88vh);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      overflow: hidden;
      border: 1px solid #d5cdb9;
      border-radius: 10px;
      background: #fffdf8;
      box-shadow: 0 34px 90px rgba(32,32,25,.24);
    }
    .theme-modal-head,
    .theme-modal-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: #f7f3e8;
    }
    .theme-modal-foot { border-top: 1px solid var(--line); border-bottom: 0; justify-content: flex-end; }
    .theme-modal-title { font-family: Georgia, serif; font-size: 20px; line-height: 1.1; }
    .theme-modal-sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .theme-search-wrap { padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .theme-list {
      overflow: auto;
      padding: 14px 16px 18px;
    }
    .theme-section { margin-bottom: 16px; }
    .theme-section-title {
      color: #7b6f58;
      font-size: 11px;
      font-weight: 750;
      letter-spacing: .1em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .theme-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      gap: 9px;
    }
    .theme-card {
      position: relative;
      min-height: 86px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(145deg, rgba(255,255,255,.7), rgba(243,240,230,.72)),
        #fffdf8;
      padding: 12px 38px 12px 12px;
      text-align: left;
      color: var(--ink);
      cursor: pointer;
    }
    .theme-card:hover {
      border-color: #c8b98d;
      box-shadow: 0 10px 26px rgba(32,32,25,.1);
      transform: translateY(-1px);
    }
    .theme-card.selected {
      border-color: var(--accent);
      background: #e9f3ee;
      box-shadow: inset 0 0 0 1px rgba(14,111,92,.18);
    }
    .theme-name { display: block; font-weight: 750; line-height: 1.25; }
    .theme-id {
      display: block;
      margin-top: 4px;
      color: #8d8b80;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    .theme-desc {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    .theme-fav {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 30px;
      height: 30px;
      padding: 0;
      border-radius: 999px;
      border: 1px solid #d9bd63;
      background: #fff4c4;
      color: #8a6500;
      font-size: 18px;
      line-height: 1;
      box-shadow: 0 5px 14px rgba(121, 89, 0, .16);
    }
    .theme-fav:hover { border-color: #b68b12; background: #ffe58a; color: #6f4c00; }
    .theme-fav.on { color: #fff8d9; background: #b48200; border-color: #8f6500; }
    .theme-empty {
      color: var(--muted);
      text-align: center;
      padding: 34px 12px;
      border: 1px dashed var(--line);
      border-radius: 8px;
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
