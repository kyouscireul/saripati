import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

mkdirSync("dist/ui", { recursive: true });
copyFileSync("src/ui/web.html", "dist/ui/web.html");
console.log("  copied src/ui/web.html → dist/ui/web.html");

// Vendor the browser ESM bundles so the published package serves the dashboard
// without preact/htm as runtime dependencies (they stay devDependencies).
mkdirSync("dist/vendor", { recursive: true });
const moduleFrom = (p) => p.replace(/\.js$/, ".module.js");
const vendor = {
  "preact.module.js": moduleFrom(require.resolve("preact")),
  "hooks.module.js": moduleFrom(require.resolve("preact/hooks")),
  "htm.module.js": moduleFrom(require.resolve("htm")),
};
for (const [name, src] of Object.entries(vendor)) {
  copyFileSync(src, `dist/vendor/${name}`);
  console.log(`  vendored ${name}`);
}
