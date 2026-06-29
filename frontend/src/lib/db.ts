// Paper-cache persistence shim. Previously IndexedDB-backed; now delegates to
// the server's global paper cache (/api/papers). The conversations + annotations
// stores no longer use this module (they call lib/api directly), but several
// call sites still import getPaper/savePaper from here — kept as a thin facade
// so they need no changes.
//
// For the one-time browser→server migration, see lib/legacyDb.ts which still
// reads the old IndexedDB stores.

import * as api from "./api";
import type { Paper } from "../types";

export type StoredPaper = Paper & { full_text?: string; fetched_at: number };

/** Get a cached paper (metadata + extracted full_text) by arxiv id. Returns
 *  undefined when not cached (matches the old IDB signature). */
export async function getPaper(arxivId: string): Promise<StoredPaper | undefined> {
  try {
    const p = await api.getPaper(arxivId);
    return p ?? undefined;
  } catch {
    return undefined;
  }
}

/** Upsert a paper into the global cache (metadata + extracted full_text). */
export async function savePaper(p: StoredPaper): Promise<void> {
  await api.putPaper(p);
}
