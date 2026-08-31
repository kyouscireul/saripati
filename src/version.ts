import { readFileSync } from "node:fs";

/**
 * The running package version, read from package.json at runtime.
 *
 * Lives one directory below the package root in both layouts — `src/version.ts`
 * in the repo, `dist/version.js` in the published tarball — so the same
 * relative hop resolves in each. Falls back to "unknown" rather than throwing:
 * reporting a version is never worth crashing a command over.
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();
