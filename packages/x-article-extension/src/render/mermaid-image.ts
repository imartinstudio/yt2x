import mermaid from "mermaid";

let initialized = false;

const ensureMermaid = (): void => {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
  });
  initialized = true;
};

export const renderMermaidToPngBlob = async (source: string): Promise<Blob> => {
  ensureMermaid();
  const id = `yt2x-mermaid-${crypto.randomUUID().replaceAll("-", "")}`;
  const { svg } = await mermaid.render(id, source.trim());
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    const scale = 2;
    canvas.width = Math.ceil(image.naturalWidth * scale);
    canvas.height = Math.ceil(image.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Canvas 2D context was unavailable for Mermaid PNG export.");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result === null) reject(new Error("Mermaid PNG conversion failed."));
        else resolve(result);
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load rendered Mermaid diagram."));
    image.src = url;
  });
