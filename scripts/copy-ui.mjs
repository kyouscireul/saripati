import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist/ui", { recursive: true });
copyFileSync("src/ui/web.html", "dist/ui/web.html");
console.log("  copied src/ui/web.html → dist/ui/web.html");
