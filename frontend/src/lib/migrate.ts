// One-time browser → server migration. On first login after the upgrade, if
// the browser still holds legacy IndexedDB + localStorage data, the App boot
// offers to import it into the now-authenticated user's server account. The
// server endpoint upserts by id (idempotent), so re-importing is a no-op.

import * as api from "./api";
import {
  legacyDbHasData, readLegacyConversations, readLegacyPapers, readLegacyAnnotations,
  readLegacySettings, readLegacyZoteroNoteSync,
} from "./legacyDb";

const MIGRATE_DONE_KEY = "lax-migrate-done";

/** True if the browser holds any legacy pre-persistence data worth importing. */
export async function hasLocalDataToMigrate(): Promise<boolean> {
  if (localStorage.getItem(MIGRATE_DONE_KEY)) return false;
  const settings = readLegacySettings();
  const zns = readLegacyZoteroNoteSync();
  const hasSettings = !!(settings && (settings.providers?.length || settings.theme && settings.theme !== "default"));
  const hasZns = !!(zns && Object.keys(zns).length > 0);
  return (await legacyDbHasData()) || hasSettings || hasZns;
}

/** Read all legacy browser data and POST it to the server under the current
 *  user. Returns the server's import counts. Throws on failure. */
export async function importLocalData(): Promise<{ imported: Record<string, number> }> {
  const [conversations, papers, annotations] = await Promise.all([
    readLegacyConversations(),
    readLegacyPapers(),
    readLegacyAnnotations(),
  ]);
  const settings = readLegacySettings();
  const zoteroNoteSync = readLegacyZoteroNoteSync();

  const payload: api.MigratePayload = {
    conversations,
    papers,
    annotations,
    settings: settings ? {
      providers: settings.providers.map((p: any) => ({
        id: p.id, name: p.name, base_url: p.base_url, api_key: p.api_key,
        model: p.model, vision_model: p.vision_model ?? null, is_default: p.is_default ?? false,
      })),
      defaultProviderId: settings.defaultProviderId,
      theme: settings.theme,
      searchSources: settings.searchSources,
      zotero: settings.zotero,
      providerModels: settings.providerModels,
    } : null,
    zoteroNoteSync: zoteroNoteSync
      ? Object.fromEntries(
          Object.entries(zoteroNoteSync).map(([arxivId, v]: [string, any]) => [
            arxivId,
            {
              enabled: v.enabled ?? false,
              note_key: v.noteKey ?? null,
              parent_key: v.parentKey ?? null,
              last_synced_at: v.lastSyncedAt ?? null,
              last_error: v.lastError ?? null,
              last_count: v.lastCount ?? 0,
              content_sig: v.contentSig ?? null,
            },
          ])
        )
      : null,
  };

  const result = await api.importLocalData(payload);
  localStorage.setItem(MIGRATE_DONE_KEY, "1");
  return result;
}
