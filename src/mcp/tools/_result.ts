/** Shared helpers for shaping MCP tool results. */

import { banner, VERSION } from "../../term/theme.js";

// No ANSI codes in tool response text — the host renders it as plain text.
// Unicode box-drawing is fine (Claude Code, VS Code, etc. are all UTF-8).
const MCP_CAPS = { color: false, unicode: true };

export interface ToolText {
  // The MCP SDK's CallToolResult carries an open index signature; mirror it so
  // our helper's return type is assignable to the tool handler contract.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
}

/** A human-readable summary line followed by the structured JSON payload. */
export function jsonResult(summary: string, data: unknown): ToolText {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  };
}

/**
 * Like jsonResult but prefixed with the SARIPATI wordmark banner.
 * Use for high-visibility tools (on, off, corpus) so the host always
 * sees a clear visual anchor for SARIPATI output.
 */
export function bannerResult(summary: string, data: unknown): ToolText {
  const header = banner(VERSION, MCP_CAPS);
  return {
    content: [{ type: "text", text: `${header}\n\n${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  };
}

export function textResult(text: string): ToolText {
  return { content: [{ type: "text", text }] };
}

/** Derive a short title from free-form content (first line, truncated). */
export function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "Untitled";
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

/** A compact excerpt of an entry body for search results. */
export function excerpt(body: string, max = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
