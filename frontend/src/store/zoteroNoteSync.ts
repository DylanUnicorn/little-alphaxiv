// Per-paper state for the "Create Note from Annotations" Zotero sync. Persisted
// to localStorage so an enabled paper resumes syncing when the user reopens it
// (and so the ZoteroPanel reflects the last sync result even after a reload).
// `syncing` is ephemeral — reset to false on rehydration since no sync is in
// flight across a reload.
//
// Default is ENABLED (`DEFAULT_PAPER_SYNC.enabled = true`). The sync engine
// still no-ops until Zotero web creds are configured (see useZoteroNoteSync),
// so a user who never sets up Zotero is never bothered by this — the checkbox
// simply stays disabled ("requires Web API mode") and nothing runs.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface PaperNoteSync {
  enabled: boolean;
  /** Cached Zotero key of the annotations child note (lets the backend PATCH
   *  directly instead of listing children each sync). */
  noteKey: string | null;
  /** Cached Zotero key of the parent paper item (avoids re-searching each sync). */
  parentKey: string | null;
  /** ms epoch of the last SUCCESSFUL sync (not advanced on error). */
  lastSyncedAt: number | null;
  lastError: string | null;
  /** annotations included in the last successful sync. */
  lastCount: number;
  syncing: boolean;
  /** Stable signature of the note HTML we last wrote to Zotero. The sync
   *  engine computes a signature of the freshly built note and skips the
   *  PATCH when it equals this — so unchanged annotations never bump the
   *  note's server version. That is what keeps the desktop client's local
   *  copy marked synced (no concurrent-modified-field conflict dialog). It is
   *  dropped whenever the note or parent goes missing (clearKeys) so a
   *  forced rewrite still happens after a deletion. */
  contentSig: string | null;
}

export const DEFAULT_PAPER_SYNC: PaperNoteSync = {
  enabled: true,
  noteKey: null,
  parentKey: null,
  lastSyncedAt: null,
  lastError: null,
  lastCount: 0,
  syncing: false,
  contentSig: null,
};

interface ZoteroNoteSyncState {
  papers: Record<string, PaperNoteSync>;
  setEnabled: (arxivId: string, enabled: boolean) => void;
  beginSync: (arxivId: string) => void;
  finishSync: (
    arxivId: string,
    r: {
      noteKey?: string;
      parentKey?: string;
      count: number;
      error?: string;
      /** drop cached noteKey+parentKey so the next run rediscovers (used when
       *  an upsert failed, e.g. the note/parent was deleted in Zotero). */
      clearKeys?: boolean;
      /** content signature of the note HTML just written (skipped writes pass
       *  the unchanged signature through). Persisted so the skip persists
       *  across reloads; dropped on clearKeys so a forced rewrite happens. */
      contentSig?: string | null;
    }
  ) => void;
}

export const useZoteroNoteSyncStore = create<ZoteroNoteSyncState>()(
  persist(
    (set) => ({
      papers: {},
      setEnabled: (arxivId, enabled) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [arxivId]: {
              ...(s.papers[arxivId] || DEFAULT_PAPER_SYNC),
              enabled,
              // clearing the error on enable so a stale failure doesn't linger;
              // on disable we also clear it so the panel stops showing errors.
              lastError: null,
            },
          },
        })),
      beginSync: (arxivId) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [arxivId]: { ...(s.papers[arxivId] || DEFAULT_PAPER_SYNC), syncing: true },
          },
        })),
      finishSync: (arxivId, r) =>
        set((s) => {
          const prev = s.papers[arxivId] || DEFAULT_PAPER_SYNC;
          return {
            papers: {
              ...s.papers,
              [arxivId]: {
                ...prev,
                syncing: false,
                lastSyncedAt: r.error ? prev.lastSyncedAt : Date.now(),
                lastError: r.error ?? null,
                lastCount: r.count,
                noteKey: r.clearKeys ? null : r.noteKey ?? prev.noteKey ?? null,
                parentKey: r.clearKeys ? null : r.parentKey ?? prev.parentKey ?? null,
                contentSig: r.clearKeys
                  ? null
                  : r.contentSig !== undefined
                    ? r.contentSig
                    : prev.contentSig ?? null,
              },
            },
          };
        }),
    }),
    {
      name: "little-alphaxiv-zotero-note-sync",
      partialize: (s) => ({ papers: s.papers }),
      merge: (persisted, current) => {
        const p = (persisted as { papers?: Record<string, PaperNoteSync> })?.papers || {};
        const cleaned: Record<string, PaperNoteSync> = {};
        for (const [k, v] of Object.entries(p)) {
          cleaned[k] = { ...(v as PaperNoteSync), syncing: false };
        }
        return { ...current, papers: cleaned };
      },
    }
  )
);
