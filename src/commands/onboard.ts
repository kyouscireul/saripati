import { createInterface } from "node:readline/promises";
import { openDb } from "../db/db.js";
import { resolvePaths } from "../config.js";
import { getIdentity, upsertIdentity, clearIdentity, type IdentityRow } from "../db/queries.js";
import { PERSONAS, findPersona } from "../data/personas.js";
import { banner, frame, steps, caps, c, sym } from "../term/theme.js";

/**
 * `saripati onboard` — capture who this vault belongs to and an optional AI
 * companion persona, so any host can load "who am I working with" at boot.
 *
 *   saripati onboard            Interactive setup (readline, zero deps).
 *   saripati onboard --print    Show the current identity.
 *   saripati onboard --reset    Clear the identity row.
 */
export async function runOnboard(argv: string[]): Promise<void> {
  const paths = resolvePaths(argv);
  const db = openDb(paths);
  const out = process.stdout;

  try {
    if (argv.includes("--print")) {
      out.write(`${renderIdentity(getIdentity(db))}\n`);
      return;
    }
    if (argv.includes("--reset")) {
      clearIdentity(db);
      out.write(`${c.dim(sym.bullet)} Identity cleared.\n`);
      return;
    }

    await interactive(db);
  } finally {
    db.close();
  }
}

async function interactive(db: ReturnType<typeof openDb>): Promise<void> {
  const out = process.stdout;
  const cap = caps(process.stdout);

  // On a real terminal, read line-by-line as the user types. When stdin is piped
  // (scripting or CI), Node's readline/promises only settles the first question,
  // so pre-buffer all lines and answer them in order — same flow, scriptable.
  const tty = Boolean(process.stdin.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const buffered = tty ? [] : await readAllLines();
  let cursor = 0;

  const ask = async (q: string, def?: string): Promise<string> => {
    const hint = def ? c.dim(` (${def})`) : "";
    const prompt = `  ${c.amber(sym.arrow)} ${q}${hint}: `;
    if (rl) {
      const answer = (await rl.question(prompt)).trim();
      return answer || def || "";
    }
    const line = cursor < buffered.length ? buffered[cursor++] : "";
    out.write(`${prompt}${line}\n`);
    return line.trim() || def || "";
  };

  try {
    out.write(`\n${banner(undefined, cap)}\n\n`);
    out.write(`  ${c.dim("Let's set up your vault. Press Enter to accept a default or skip.")}\n\n`);

    // Step 1 — the user ------------------------------------------------------
    out.write(`${steps(1, 5, c.bold("About you"))}\n`);
    const userName = await ask("Your name");
    const userField = await ask("Your field or work");

    // Step 2 — preferences ---------------------------------------------------
    out.write(`\n${steps(2, 5, c.bold("How you like to work"))}\n`);
    const skills = splitList(await ask("Skills / focus areas, comma-separated"));
    const commStyle = await ask("Preferred communication style", "direct, concise");
    const address = await ask("How should the AI address you", userName || "by name");
    const language = await ask("Preferred language", "English");

    // Step 3 — pick a companion persona -------------------------------------
    out.write(`\n${steps(3, 5, c.bold("Companion persona"))}\n`);
    out.write(`  ${c.dim("Pick a starting point (you can customize it next):")}\n`);
    PERSONAS.forEach((p, i) => out.write(`    ${c.amber(String(i + 1))}  ${p.label}\n`));
    const pickRaw = await ask("Choose 1-" + PERSONAS.length, "1");
    const pick = PERSONAS[Math.max(1, Math.min(PERSONAS.length, Number(pickRaw) || 1)) - 1];
    const preset = findPersona(pick.id) ?? PERSONAS[0];

    // Step 4 — customize the companion --------------------------------------
    out.write(`\n${steps(4, 5, c.bold("Customize the companion"))}\n`);
    let companionName = preset.companion_name ?? "";
    let companionRole = preset.companion_role ?? "";
    let companionTone = preset.companion_tone ?? "";
    if (preset.id !== "plain") {
      companionName = await ask("Companion name", preset.companion_name);
      companionRole = await ask("Companion role", preset.companion_role);
      companionTone = await ask("Companion tone", preset.companion_tone);
    } else {
      out.write(`  ${c.dim("Plain preset — no companion. Skipping.")}\n`);
    }

    // Step 5 — write + confirm ----------------------------------------------
    out.write(`\n${steps(5, 5, c.bold("Save"))}\n`);
    const identity = upsertIdentity(db, {
      user_name: userName || null,
      user_field: userField || null,
      user_prefs: {
        skills,
        communication_style: commStyle,
        address,
        language,
      },
      companion_name: companionName || null,
      companion_role: companionRole || null,
      companion_tone: companionTone || null,
      companion_config: preset.companion_config,
    });

    out.write(`\n${renderIdentity(identity)}\n`);
    out.write(`\n  ${c.ok(sym.ok)} Identity saved to the vault.\n`);
    out.write(
      `\n  ${c.dim("Next:")} tell your AI host to call ${c.amber("session_boot")} at the start` +
        ` of a session —\n  it now loads this identity alongside your recent work.\n`,
    );
    out.write(
      `  ${c.dim("Tip:")} once a knowledge folder is enabled, ${c.amber("saripati export --md")}` +
        ` mirrors it to Markdown.\n`,
    );
  } finally {
    rl?.close();
  }
}

/** Buffer all of piped stdin into lines (non-TTY onboarding path). */
async function readAllLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Render the identity as a titled box, or a hint if none is set yet. */
function renderIdentity(identity: IdentityRow | null): string {
  const cap = caps(process.stdout);
  if (!identity) {
    return frame("identity", [c.dim("No identity set. Run ") + c.amber("saripati onboard") + c.dim(" to begin.")], cap);
  }
  const prefs = identity.user_prefs as {
    skills?: unknown;
    communication_style?: unknown;
    address?: unknown;
    language?: unknown;
  };
  const skills = Array.isArray(prefs.skills) ? (prefs.skills as string[]).join(", ") : "";
  const rows = [
    `${label("name")}  ${identity.user_name ?? c.dim("—")}`,
    `${label("field")}  ${identity.user_field ?? c.dim("—")}`,
    `${label("skills")}  ${skills || c.dim("—")}`,
    `${label("style")}  ${strOr(prefs.communication_style)}`,
    `${label("address")}  ${strOr(prefs.address)}`,
    `${label("language")}  ${strOr(prefs.language)}`,
  ];
  if (identity.companion_name || identity.companion_role) {
    rows.push(c.dim("─ companion ─"));
    rows.push(`${label("name")}  ${identity.companion_name ?? c.dim("—")}`);
    rows.push(`${label("role")}  ${identity.companion_role ?? c.dim("—")}`);
    if (identity.companion_tone) rows.push(`${label("tone")}  ${identity.companion_tone}`);
  }
  return frame("identity", rows, cap);
}

function label(s: string): string {
  return c.dim(s.padEnd(8));
}

function strOr(v: unknown): string {
  return v ? String(v) : c.dim("—");
}
