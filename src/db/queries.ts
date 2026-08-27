/* --------------------------------------------------------------------------
 * Barrel — the vault's query surface, re-exported from focused domain modules
 * under ./queries/. Consumers import from "../db/queries.js" unchanged; each
 * module owns one concern (entries, search, sessions, projects, identity,
 * corpus). See ./queries/_json.ts for the shared JSON parse helpers.
 * ------------------------------------------------------------------------ */

export * from "./queries/entries.js";
export * from "./queries/search.js";
export * from "./queries/sessions.js";
export * from "./queries/projects.js";
export * from "./queries/identity.js";
export * from "./queries/corpus.js";
