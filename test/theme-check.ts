/**
 * SARIPATI theme visual-audit harness.
 *
 * Run: npm run theme:check
 *
 * This renders every frame/banner/report/steps variant to stdout so you can
 * inspect all shapes at a glance before pushing. It is NOT a snapshot test —
 * it is a structured visual audit for the human eye. Programmatic degradation
 * assertions live in test/smoke.ts (section 0).
 */
import {
  banner,
  frame,
  report,
  steps,
  caps,
  paint,
  symbols,
  type Caps,
} from "../src/term/theme.js";

const plain: Caps = { color: false, unicode: false };
const colAscii: Caps = { color: true, unicode: false };   // colour, ASCII glyphs (piped CI)
const full: Caps = { color: true, unicode: true };         // full output (real TTY)

const hr = (label: string) =>
  `\n${"─".repeat(60)}\n  ${label}\n${"─".repeat(60)}\n`;

process.stdout.write(hr("1. BANNER — plain ASCII (non-TTY / piped / CI)"));
process.stdout.write(banner("0.2.0-check", plain) + "\n");

process.stdout.write(hr("2. BANNER — colour, ASCII box (FORCE_COLOR, piped)"));
process.stdout.write(banner("0.2.0-check", colAscii) + "\n");

process.stdout.write(hr("3. BANNER — colour + Unicode (real terminal)"));
process.stdout.write(banner("0.2.0-check", full) + "\n");

process.stdout.write(hr("4. FRAME — no title (minimum width)"));
process.stdout.write(frame("", ["row one", "row two"], full) + "\n");

process.stdout.write(hr("5. FRAME — short title (narrower than minimum body)"));
process.stdout.write(frame("ok", ["a", "bb", "ccc"], full) + "\n");

process.stdout.write(hr("6. FRAME — long title (wider than body rows)"));
process.stdout.write(frame("import ← md with a very long title here", ["done"], full) + "\n");

process.stdout.write(hr("7. FRAME — rows with inline colour (verifies paintBorders)"));
const p = paint(full);
const s = symbols(full);
const colorRows = [
  `${p.ok(s.ok)} everything is fine`,
  `${p.err(s.err)} this failed`,
  `${p.dim(s.bullet)} skipped item`,
  `${p.amber(s.arrow)} in progress`,
  `${p.warn("warn")} check this`,
];
process.stdout.write(frame("coloured rows", colorRows, full) + "\n");

process.stdout.write(hr("8. REPORT — full semantic tones"));
process.stdout.write(
  report(
    "import ← md",
    { created: 3, updated: 5, unchanged: 12, conflicted: 1, orphaned: 2, pruned: 0 },
    full,
  ) + "\n",
);

process.stdout.write(hr("9. STEPS — onboarding progress"));
for (let i = 1; i <= 5; i++) {
  process.stdout.write(steps(i, 5, `Step ${i} label here`) + "\n");
}

process.stdout.write(hr("10. FRAME — plain ASCII equivalents of 6 + 8 above"));
process.stdout.write(frame("coloured rows", colorRows, plain) + "\n\n");
process.stdout.write(
  report(
    "import ← md",
    { created: 3, updated: 5, unchanged: 12, conflicted: 1, orphaned: 2, pruned: 0 },
    plain,
  ) + "\n",
);

process.stdout.write("\n  Visual audit complete — inspect each shape above.\n\n");
