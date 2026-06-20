// Per-paper state for the "Create Note from Annotations" Zotero sync. Persisted
// to localStorage so an enabled paper resumes syncing when the user reopens it
// (and so the ZoteroPanel reflects the last sync result even after a reload).
// `syncing` is ephemeral — reset to false on rehydration since no sync is in
// flight across a reload.

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
}

export const DEFAULT_PAPER_SYNC: PaperNoteSync = {
  enabled: false,
  noteKey: null,
  parentKey: null,
  lastSyncedAt: null,
  lastError: null,
  lastCount: 0,
  syncing: false,
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
