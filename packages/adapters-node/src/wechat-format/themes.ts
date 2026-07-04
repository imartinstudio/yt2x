export type WechatTheme = {
  id: string;
  name: string;
  description: string;
  /** Inline styles injected into article.html via style="" attributes. WeChat strips
   *  <style> and <link> tags, so everything must be inline. */
  styles: {
    /** Wrapper for the full article body */
    article: string;
    h2: string;
    h3: string;
    h4: string;
    h5: string;
    h6: string;
    p: string;
    blockquote: string;
    pre: string;
    code: string;
    table: string;
    th_td: string;
    ul_ol: string;
    li: string;
    a: string;
    img: string;
    hr: string;
    strong: string;
    em: string;
    /** H1 title rendered as a standalone block */
    title: string;
  };
  /** CSS fragment injected into <style> for preview.html */
  previewCss: string;
};

const GITHUB_STYLES: WechatTheme["styles"] = {
  article:
    "max-width:680px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif,'Apple Color Emoji','Segoe UI Emoji';color:#24292f;line-height:1.6;",
  title:
    "font-size:28px;font-weight:700;color:#1a1a2e;line-height:1.3;margin-bottom:24px;padding-bottom:12px;border-bottom:2px solid #e8e8e8;",
  h2: "font-size:22px;font-weight:600;color:#1a1a2e;margin:28px 0 12px;line-height:1.4;",
  h3: "font-size:18px;font-weight:600;color:#2d2d44;margin:24px 0 10px;line-height:1.4;",
  h4: "font-size:16px;font-weight:600;color:#3d3d5c;margin:20px 0 8px;line-height:1.4;",
  h5: "font-size:15px;font-weight:600;color:#3d3d5c;margin:18px 0 6px;line-height:1.4;",
  h6: "font-size:14px;font-weight:600;color:#555;margin:16px 0 6px;line-height:1.4;",
  p: "font-size:16px;color:#24292f;line-height:1.8;margin:0 0 14px;",
  blockquote:
    "margin:16px 0;padding:10px 16px;border-left:4px solid #0969da;background:#f6f8fa;color:#57606a;font-size:15px;line-height:1.7;",
  pre: "background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:16px;overflow-x:auto;margin:16px 0;line-height:1.5;",
  code: "font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;color:#24292f;",
  table:
    "border-collapse:collapse;width:100%;margin:16px 0;font-size:15px;",
  th_td: "border:1px solid #d0d7de;padding:8px 12px;text-align:left;",
  ul_ol: "margin:0 0 14px;padding-left:24px;",
  li: "font-size:16px;color:#24292f;line-height:1.8;margin-bottom:4px;",
  a: "color:#0969da;text-decoration:underline;",
  img: "max-width:100%;height:auto;border-radius:6px;margin:12px 0;display:block;",
  hr: "border:none;border-top:1px solid #d0d7de;margin:24px 0;",
  strong: "font-weight:600;color:#1a1a2e;",
  em: "font-style:italic;",
};

const GITHUB_PREVIEW_CSS = `
  body { background:#f0f2f5; padding:20px; }
  .wx-article { background:#fff; border-radius:8px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
`;

const NEWSPAPER_STYLES: WechatTheme["styles"] = {
  article:
    "max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#333;line-height:1.8;",
  title:
    "font-size:30px;font-weight:700;color:#1a1a1a;line-height:1.3;margin-bottom:20px;text-align:center;",
  h2: "font-size:22px;font-weight:700;color:#222;margin:32px 0 14px;line-height:1.4;text-align:center;",
  h3: "font-size:18px;font-weight:700;color:#333;margin:28px 0 10px;line-height:1.5;",
  h4: "font-size:16px;font-weight:700;color:#444;margin:24px 0 8px;line-height:1.5;",
  h5: "font-size:15px;font-weight:700;color:#555;margin:20px 0 6px;line-height:1.5;",
  h6: "font-size:14px;font-weight:700;color:#666;margin:18px 0 6px;line-height:1.5;",
  p: "font-size:17px;color:#333;line-height:1.9;margin:0 0 16px;text-align:justify;text-indent:2em;",
  blockquote:
    "margin:20px 0;padding:12px 20px;border-left:3px solid #8b0000;background:#fdf8f0;color:#5a4a3a;font-size:15px;line-height:1.8;font-style:italic;",
  pre: "background:#fafafa;border:1px solid #e0ddd5;padding:16px;overflow-x:auto;margin:18px 0;line-height:1.5;font-size:14px;",
  code: "font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:13px;color:#4a4a4a;",
  table:
    "border-collapse:collapse;width:100%;margin:18px 0;font-size:15px;",
  th_td: "border:1px solid #ccc;padding:10px 14px;text-align:left;",
  ul_ol: "margin:0 0 16px;padding-left:28px;",
  li: "font-size:17px;color:#333;line-height:1.9;margin-bottom:6px;",
  a: "color:#8b0000;text-decoration:underline;",
  img: "max-width:100%;height:auto;margin:16px 0;display:block;",
  hr: "border:none;border-top:1px solid #ddd;margin:32px 0;",
  strong: "font-weight:700;color:#1a1a1a;",
  em: "font-style:italic;",
};

const NEWSPAPER_PREVIEW_CSS = `
  body { background:#f5f0e8; padding:20px; }
  .wx-article { background:#fffef9; border-radius:4px; padding:40px; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
`;

const MINIMAL_STYLES: WechatTheme["styles"] = {
  article:
    "max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111;line-height:1.7;",
  title:
    "font-size:26px;font-weight:700;color:#000;line-height:1.3;margin-bottom:20px;",
  h2: "font-size:20px;font-weight:600;color:#111;margin:36px 0 12px;line-height:1.4;",
  h3: "font-size:17px;font-weight:600;color:#222;margin:28px 0 10px;line-height:1.4;",
  h4: "font-size:16px;font-weight:600;color:#333;margin:24px 0 8px;line-height:1.4;",
  h5: "font-size:15px;font-weight:600;color:#444;margin:20px 0 6px;line-height:1.4;",
  h6: "font-size:14px;font-weight:600;color:#555;margin:16px 0 6px;line-height:1.4;",
  p: "font-size:16px;color:#111;line-height:1.8;margin:0 0 14px;",
  blockquote:
    "margin:14px 0;padding:8px 16px;border-left:3px solid #333;color:#555;font-size:15px;line-height:1.7;",
  pre: "background:#f9f9f9;border:1px solid #eee;padding:14px;overflow-x:auto;margin:14px 0;line-height:1.5;",
  code: "font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:13px;color:#333;",
  table:
    "border-collapse:collapse;width:100%;margin:14px 0;font-size:15px;",
  th_td: "border:1px solid #ddd;padding:6px 12px;text-align:left;",
  ul_ol: "margin:0 0 14px;padding-left:24px;",
  li: "font-size:16px;color:#111;line-height:1.8;margin-bottom:4px;",
  a: "color:#000;text-decoration:underline;text-underline-offset:2px;",
  img: "max-width:100%;height:auto;margin:12px 0;display:block;",
  hr: "border:none;border-top:1px solid #eee;margin:32px 0;",
  strong: "font-weight:600;",
  em: "font-style:italic;",
};

const MINIMAL_PREVIEW_CSS = `
  body { background:#fff; padding:20px; }
  .wx-article { background:#fff; padding:24px 0; }
`;

export const BUILTIN_WECHAT_THEMES: WechatTheme[] = [
  { id: "github", name: "GitHub", description: "GitHub 风格排版，清晰简洁，适合技术文章。", styles: GITHUB_STYLES, previewCss: GITHUB_PREVIEW_CSS },
  { id: "newspaper", name: "Newspaper", description: "报纸风格排版，衬线字体，适合长文阅读。", styles: NEWSPAPER_STYLES, previewCss: NEWSPAPER_PREVIEW_CSS },
  { id: "minimal", name: "Minimal", description: "极简黑白排版，最小干扰，专注内容。", styles: MINIMAL_STYLES, previewCss: MINIMAL_PREVIEW_CSS },
];

export const DEFAULT_WECHAT_THEME_ID = "github";

export const getBuiltinWechatThemes = (): WechatTheme[] => BUILTIN_WECHAT_THEMES;

export const getWechatTheme = (id: string): WechatTheme | undefined =>
  BUILTIN_WECHAT_THEMES.find((t) => t.id === id);
