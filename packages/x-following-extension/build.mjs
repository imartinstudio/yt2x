/* eslint-env node */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const repoRoot = join(root, "..", "..");

/** Read package.json version as source of truth. */
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// --- Bundle JS ---
await esbuild.build({
  entryPoints: {
    "content/following-manager": join(root, "src/content/following-manager.ts"),
    "background/background": join(root, "src/background/background.ts"),
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: dist,
  sourcemap: false,
  minify: false,
});

// --- Build manifest (sync version from package.json) ---
const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
manifest.version = version;
manifest.version_name = version;
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// --- Copy icons ---
mkdirSync(join(dist, "icons"), { recursive: true });
for (const icon of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
  copyFileSync(join(root, "src/icons", icon), join(dist, "icons", icon));
}

// --- Copy privacy policy ---
const privacySrc = join(root, "privacy", "index.html");
if (existsSync(privacySrc)) {
  mkdirSync(join(dist, "privacy"), { recursive: true });
  copyFileSync(privacySrc, join(dist, "privacy", "index.html"));
}

console.log("Build:  %s → dist/", version);
console.log("  JS:    content/following-manager.js, background/background.js");
console.log("  Icons: 16, 32, 48, 128 PNG");

// --- Produce store-ready zip ---
const zipName = `x-following-extension-v${version}.zip`;
const zipPath = join(root, zipName);
rmSync(zipPath, { force: true });
const zipResult = spawnSync("zip", ["-r", zipPath, "."], { cwd: dist, stdio: "pipe" });
if (zipResult.status !== 0) {
  console.error("  Zip:    FAILED — %s", zipResult.stderr.toString());
  process.exit(1);
}
const zipSize = (statSync(zipPath).size / 1024).toFixed(1);
console.log("  Zip:    %s (%s KB)", zipName, zipSize);

console.log("\n✔ Chrome extension built at packages/x-following-extension/dist");
console.log("  Store-ready: packages/x-following-extension/%s", zipName);
