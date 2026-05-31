/* eslint-env node */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: {
    "content/x-articles": join(root, "src/content/x-articles.ts"),
    "background/main-world-bridge": join(root, "src/background/main-world-bridge.ts"),
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: dist,
  sourcemap: true,
  minify: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(join(dist, "icons"), { recursive: true });
for (const icon of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
  copyFileSync(join(root, "src/icons", icon), join(dist, "icons", icon));
}

process.stdout.write("Built Chrome extension at packages/chrome-extension/dist\n");
