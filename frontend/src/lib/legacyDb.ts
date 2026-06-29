// Legacy IndexedDB + localStorage reader — used ONCE by the browser→server
// migration (lib/migrate.ts) to pull pre-upgrade browser data into the user's
// server account. Read-only; never used by the live app after migration.
//
// Mirrors the original lib/db.ts (pre-persistence) shape so the existing
// migration-of-data logic applies unchanged.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, Paper, Annotation } from "../types";
import { migrateAnnotation } from "./annotations";

interface LaxDB extends DBSchema {
  conversations: { key: string; value: Conversation; indexes: { "by-updated": number } };
  papers: { key: string; value: Paper & { full_text?: string; fetched_at: number } };
  annotations: {
    key: string; value: Annotation;
    indexes: { "by-paper": string; "by-paper-page": [string, number] };
  };
}

let dbp: Promise<IDBPDatabase<LaxDB>> | null = null;

async function db(): Promise<IDBPDatabase<LaxDB>> {
  if (!dbp) {
    dbp = openDB<LaxDB>("little-alphaxiv", 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const c = d.createObjectStore("conversations", { keyPath: "id" });
          c.createIndex("by-updated", "updated_at");
          d.createObjectStore("papers", { keyPath: "arxiv_id" });
        }
        if (oldVersion < 2) {
          const a = d.createObjectStore("annotations", { keyPath: "id" });
          a.createIndex("by-paper", "arxiv_id");
          a.createIndex("by-paper-page", ["arxiv_id", "page"]);
        }
      },
    });
  }
  return dbp;
}

/** True if the legacy browser DB exists and holds any row in any store. */
export async function legacyDbHasData(): Promise<boolean> {
  try {
    const d = await db();
    const [c, p, a] = await Promise.all([
      d.count("conversations"),
      d.count("papers"),
      d.count("annotations"),
    ]);
    return c > 0 || p > 0 || a > 0;
  } catch {
    return false;
  }
}

export async function readLegacyConversations(): Promise<Conversation[]> {
  try {
    const d = await db();
    return await d.getAll("conversations");
  } catch {
    return [];
  }
}

export async function readLegacyPapers(): Promise<(Paper & { full_text?: string; fetched_at: number })[]> {
  try {
    const d = await db();
    return await d.getAll("papers");
  } catch {
    return [];
  }
}

export async function readLegacyAnnotations(): Promise<Annotation[]> {
  try {
    const d = await db();
    const all = await d.getAll("annotations");
    return all.map(migrateAnnotation);
  } catch {
    return [];
  }
}

/** Read the old localStorage settings blob (providers + theme + searchSources +
 *  zotero + providerModels) if present. Returns null if absent. */
export function readLegacySettings(): {
  providers: any[];
  defaultProviderId: string | null;
  theme: string;
  searchSources: any;
  zotero: any;
  providerModels: Record<string, any[]>;
} | null {
  try {
    const raw = localStorage.getItem("little-alphaxiv-settings");
    if (!raw) return null;
    const s = JSON.parse(raw);
    return {
      providers: s.state?.providers ?? s.providers ?? [],
      defaultProviderId: s.state?.defaultProviderId ?? s.defaultProviderId ?? null,
      theme: s.state?.theme ?? s.theme ?? "default",
      searchSources: s.state?.searchSources ?? s.searchSources ?? null,
      zotero: s.state?.zotero ?? s.zotero ?? null,
      providerModels: s.state?.providerModels ?? s.providerModels ?? {},
    };
  } catch {
    return null;
  }
}

/** Read the old per-paper Zotero note-sync localStorage map, if present. */
export function readLegacyZoteroNoteSync(): Record<string, any> | null {
  try {
    const raw = localStorage.getItem("little-alphaxiv-zotero-note-sync");
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s.state?.papers ?? s.papers ?? null;
  } catch {
    return null;
  }
}
