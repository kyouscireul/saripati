/**
 * SARIPATI — presentation layer (zero runtime dependencies).
 *
 * SARIPATI's own terminal voice: the framed `◈ S A R I P A T I` lockup, a
 * "Distilled Amber" ANSI palette, rounded box-drawing, and status glyphs.
 *
 * Engine/template separation: commands compute data, this module renders it.
 * Every helper returns a STRING — the caller chooses the stream and writes it.
 *
 * Safety contract (never broken):
 *   - All colour is opt-out-safe: disabled on non-TTY, when piped, or when
 *     NO_COLOR is set (respecting https://no-color.org). FORCE_COLOR forces on.
 *   - When colour/Unicode are off, output degrades to clean 7-bit ASCII with no
 *     escape codes — so a CI log, a pipe, or a dumb terminal never sees garbage.
 *   - Presentation MUST NOT touch the JSON-RPC channel: on the `mcp` path the
 *     banner is rendered with `caps(process.stderr)` and written to stderr only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Version — single source, read from package.json (dev: repo root; dist: root).
// ---------------------------------------------------------------------------

function resolveVersion(): string {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = resolveVersion();

// ---------------------------------------------------------------------------
// Capabilities — decided per stream (stdout vs stderr can differ under a pipe).
// ---------------------------------------------------------------------------

export interface Caps {
  color: boolean;
  unicode: boolean;
}

function noColor(): boolean {
  return "NO_COLOR" in process.env;
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

function forceColor(): boolean {
  return truthy(process.env.FORCE_COLOR);
}

/**
 * Explicit request for the full presentation, for terminals where TTY detection
 * fails but the terminal is perfectly capable — a piped-stdout host such as the
 * Claude Code terminal, an npx/npm shim on Windows, some IDE consoles. Without
 * this there is no way to ask for the rounded box: `unicode` used to depend on
 * `isTTY` alone, so those environments were stuck with `+---+` forever, and
 * FORCE_COLOR produced a mongrel (amber escapes around ASCII corners).
 *
 * Opt-in only, so the "piped output stays clean 7-bit ASCII" contract still
 * holds by default for pipes, CI logs, and the MCP stderr path.
 */
function forceRich(): boolean {
  return truthy(process.env.SARIPATI_UNICODE) || truthy(process.env.SARIPATI_RICH);
}

/** Capabilities for a given output stream. Piped / non-TTY → plain ASCII, no colour. */
export function caps(stream: NodeJS.WriteStream = process.stdout): Caps {
  const tty = Boolean(stream.isTTY);
  const ascii = process.env.SARIPATI_ASCII === "1";
  const dumb = process.env.TERM === "dumb";
  // SARIPATI_ASCII=1 and TERM=dumb are hard opt-outs — they beat the force flags.
  const rich = forceRich() && !ascii && !dumb;
  const color = forceColor() || rich || (tty && !noColor());
  const unicode = !ascii && !dumb && (rich || tty);
  return { color, unicode };
}

// ---------------------------------------------------------------------------
// Distilled Amber palette — 256-colour ANSI. Every helper is a no-op when off.
// ---------------------------------------------------------------------------

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  amber: "\x1b[38;5;214m", // primary accent — distilled gold
  gold: "\x1b[38;5;220m", // brighter accent — headings, the mark
  dim: "\x1b[38;5;245m", // soft grey — body / secondary
  ok: "\x1b[38;5;114m", // success green
  warn: "\x1b[38;5;179m", // muted yellow
  err: "\x1b[38;5;203m", // soft red
} as const;

export interface Paint {
  amber(s: string): string;
  gold(s: string): string;
  dim(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  err(s: string): string;
  bold(s: string): string;
}

/** Build colour helpers for the given capabilities. */
export function paint(cap: Caps = caps()): Paint {
  const wrap = (seq: string) => (s: string): string => (cap.color ? `${seq}${s}${SGR.reset}` : s);
  return {
    amber: wrap(SGR.amber),
    gold: wrap(SGR.gold),
    dim: wrap(SGR.dim),
    ok: wrap(SGR.ok),
    warn: wrap(SGR.warn),
    err: wrap(SGR.err),
    bold: wrap(SGR.bold),
  };
}

/** Default colour helpers, bound to stdout. */
export const c: Paint = paint(caps(process.stdout));

// ---------------------------------------------------------------------------
// Glyphs — signature mark + status symbols, with ASCII fallbacks.
// ---------------------------------------------------------------------------

export interface Symbols {
  mark: string; // ◈  the SARIPATI faceted-gem mark
  ok: string; // ✓
  err: string; // ✗
  arrow: string; // →
  bullet: string; // •
}

export function symbols(cap: Caps = caps()): Symbols {
  return cap.unicode
    ? { mark: "◈", ok: "✓", err: "✗", arrow: "→", bullet: "•" }
    : { mark: "*", ok: "[ok]", err: "[x]", arrow: "->", bullet: "*" };
}

/** Default symbols, bound to stdout. */
export const sym: Symbols = symbols(caps(process.stdout));

// ---------------------------------------------------------------------------
// Box drawing — rounded when Unicode is available, ASCII otherwise.
// ---------------------------------------------------------------------------

interface BoxChars {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

function box(cap: Caps): BoxChars {
  return cap.unicode
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string, ignoring ANSI escape codes. */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

// ---------------------------------------------------------------------------
// frame — a titled rounded box for status blocks and reports.
// ---------------------------------------------------------------------------

const PAD = 2; // inner horizontal padding on each side

/**
 * Render a titled box around pre-formatted rows (rows may already contain colour).
 *
 *   ╭─ title ──────────╮
 *   │  row one         │
 *   ╰──────────────────╯
 */
export function frame(title: string, rows: string[], cap: Caps = caps(process.stdout)): string {
  const p = paint(cap);
  const b = box(cap);
  const bodyMax = rows.reduce((m, r) => Math.max(m, visibleLen(r)), 0);
  // Inner width must fit the title header ("─ title ─") and the widest padded row.
  const titleWidth = title ? visibleLen(title) + 4 : 0; // "─ " + title + " " + one more "─"
  const inner = Math.max(bodyMax + PAD * 2, titleWidth, 8);

  const hbar = (n: number) => b.h.repeat(Math.max(0, n));
  // Colour each segment of the top border independently — wrapping the whole
  // assembled string in p.amber() would nest over p.gold(title)'s mid-string
  // SGR reset, causing the trailing dashes and closing corner to lose amber.
  const top = title
    ? `${p.amber(b.tl + b.h + " ")}${p.gold(title)}${p.amber(" " + hbar(inner - visibleLen(title) - 3) + b.tr)}`
    : p.amber(`${b.tl}${hbar(inner)}${b.tr}`);
  const bottom = p.amber(`${b.bl}${hbar(inner)}${b.br}`);

  const body = rows.map((r) => {
    const gap = inner - visibleLen(r) - PAD * 2;
    return `${b.v}${" ".repeat(PAD)}${r}${" ".repeat(Math.max(0, gap) + PAD)}${b.v}`;
  });

  return [top, ...body.map((line) => paintBorders(line, b, p)), bottom].join("\n");
}

/** Recolour just the vertical border glyphs of a body line (content keeps its own colour). */
function paintBorders(line: string, b: BoxChars, p: Paint): string {
  if (!line.startsWith(b.v)) return line;
  const inner = line.slice(b.v.length, line.length - b.v.length);
  return `${p.amber(b.v)}${inner}${p.amber(b.v)}`;
}

// ---------------------------------------------------------------------------
// banner — the framed ◈ S A R I P A T I lockup.
// ---------------------------------------------------------------------------

const BANNER_INNER = 45;

/**
 * The SARIPATI wordmark. Defaults to stdout capabilities; the `mcp` path passes
 * `caps(process.stderr)` and writes the result to stderr only.
 */
export function banner(version: string = VERSION, cap: Caps = caps(process.stdout)): string {
  const p = paint(cap);
  const s = symbols(cap);
  const b = box(cap);
  const W = BANNER_INNER;

  const row = (content: string) => {
    const gap = W - visibleLen(content);
    return `${p.amber(b.v)}${content}${" ".repeat(Math.max(0, gap))}${p.amber(b.v)}`;
  };

  const top = p.amber(`${b.tl}${b.h.repeat(W)}${b.tr}`);
  const bottom = p.amber(`${b.bl}${b.h.repeat(W)}${b.br}`);

  const title = `   ${p.gold(s.mark)}  ${p.bold(p.amber("S A R I P A T I"))}`;
  const tagline = `      ${p.dim("the essence of what you know")}`;
  const ver = p.dim(`v${version}`);
  const verLine = " ".repeat(Math.max(0, W - visibleLen(ver) - 3)) + ver + "   ";

  return [top, row(""), row(title), row(tagline), row(verLine), bottom].join("\n");
}

// ---------------------------------------------------------------------------
// steps — [n/N] progress line for multi-step flows (onboarding).
// ---------------------------------------------------------------------------

export function steps(n: number, total: number, label: string, cap: Caps = caps(process.stdout)): string {
  const p = paint(cap);
  return `${p.amber(`[${n}/${total}]`)} ${label}`;
}

// ---------------------------------------------------------------------------
// report — a shared result table for export / import / sync counts.
// ---------------------------------------------------------------------------

/** Map a count label to a semantic tone. */
function toneFor(key: string, p: Paint): (s: string) => string {
  const k = key.toLowerCase();
  if (/(creat|add|ok|import|export|written|sync)/.test(k)) return p.ok;
  if (/(updat|chang)/.test(k)) return p.amber;
  if (/(conflict|error|fail)/.test(k)) return p.err;
  if (/(skip|orphan|prun|delet|remov)/.test(k)) return p.dim;
  return (s) => s;
}

/**
 * Render a titled table of `{ label: count }` pairs, each count coloured by
 * semantic tone. Used by export/import/sync command output.
 */
export function report(
  title: string,
  counts: Record<string, number>,
  cap: Caps = caps(process.stdout),
): string {
  const p = paint(cap);
  const s = symbols(cap);
  const entries = Object.entries(counts);
  const labelWidth = entries.reduce((m, [k]) => Math.max(m, k.length), 0);
  const rows = entries.map(([k, v]) => {
    const tone = toneFor(k, p);
    return `${p.dim(s.bullet)} ${k.padEnd(labelWidth)}  ${tone(String(v))}`;
  });
  return frame(title, rows, cap);
}
