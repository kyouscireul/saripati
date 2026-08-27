import type { DB } from "../db.js";
import { safeParseObject } from "./_json.js";

/* --------------------------------------------------------------------------
 * Identity (singleton — who this vault belongs to + optional AI companion)
 * ------------------------------------------------------------------------ */

export interface IdentityInput {
  user_name?: string | null;
  user_field?: string | null;
  user_prefs?: Record<string, unknown>;
  companion_name?: string | null;
  companion_role?: string | null;
  companion_tone?: string | null;
  companion_config?: Record<string, unknown>;
}

export interface IdentityRow {
  id: number;
  user_name: string | null;
  user_field: string | null;
  user_prefs: Record<string, unknown>;
  companion_name: string | null;
  companion_role: string | null;
  companion_tone: string | null;
  companion_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface RawIdentityRow extends Omit<IdentityRow, "user_prefs" | "companion_config"> {
  user_prefs: string;
  companion_config: string;
}

function hydrateIdentity(raw: RawIdentityRow): IdentityRow {
  return {
    ...raw,
    user_prefs: safeParseObject(raw.user_prefs),
    companion_config: safeParseObject(raw.companion_config),
  };
}

export function getIdentity(db: DB): IdentityRow | null {
  const raw = db.prepare(`SELECT * FROM identity WHERE id = 1`).get() as RawIdentityRow | undefined;
  return raw ? hydrateIdentity(raw) : null;
}

/**
 * Insert or update the singleton identity row. Scalar fields are only replaced
 * when provided (COALESCE); the JSON prefs/config objects are merged (json_patch)
 * so callers can build the persona incrementally — mirrors upsertProject.
 */
export function upsertIdentity(db: DB, input: IdentityInput): IdentityRow {
  db.prepare(
    `INSERT INTO identity
       (id, user_name, user_field, user_prefs, companion_name, companion_role, companion_tone, companion_config, updated_at)
     VALUES
       (1, @user_name, @user_field, @user_prefs, @companion_name, @companion_role, @companion_tone, @companion_config, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       user_name        = COALESCE(excluded.user_name, identity.user_name),
       user_field       = COALESCE(excluded.user_field, identity.user_field),
       user_prefs       = json_patch(identity.user_prefs, excluded.user_prefs),
       companion_name   = COALESCE(excluded.companion_name, identity.companion_name),
       companion_role   = COALESCE(excluded.companion_role, identity.companion_role),
       companion_tone   = COALESCE(excluded.companion_tone, identity.companion_tone),
       companion_config = json_patch(identity.companion_config, excluded.companion_config),
       updated_at       = datetime('now')`,
  ).run({
    user_name: input.user_name ?? null,
    user_field: input.user_field ?? null,
    user_prefs: JSON.stringify(input.user_prefs ?? {}),
    companion_name: input.companion_name ?? null,
    companion_role: input.companion_role ?? null,
    companion_tone: input.companion_tone ?? null,
    companion_config: JSON.stringify(input.companion_config ?? {}),
  });
  return getIdentity(db)!;
}

/** Clear the singleton identity row (used by `saripati onboard --reset`). */
export function clearIdentity(db: DB): void {
  db.prepare(`DELETE FROM identity WHERE id = 1`).run();
}
