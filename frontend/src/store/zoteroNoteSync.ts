// Per-paper state for the "Create Note from Annotations" Zotero sync. Persisted
// server-side (per-user, per-paper) so an enabled paper resumes syncing when
// the user reopens it (and so the ZoteroPanel reflects the last sync result
// even after a reload). `syncing` is ephemeral — never persisted.

import { create } from "zustand";
import * as api from "../lib/api";

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
  /** content signature of the last-written note HTML (skip-if-unchanged). */
  contentSig: string | null;
}

export const DEFAULT_PAPER_SYNC: PaperNoteSync = {
  enabled: false,
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
  loaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
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
      contentSig?: string;
    }
  ) => void;
}

export const useZoteroNoteSyncStore = create<ZoteroNoteSyncState>((set) => ({
  papers: {},
  loaded: false,

  load: async () => {
    try {
      const remote = await api.listNoteSync();
      const papers: Record<string, PaperNoteSync> = {};
      for (const [arxivId, n] of Object.entries(remote)) {
        papers[arxivId] = {
          enabled: n.enabled,
          noteKey: n.noteKey,
          parentKey: n.parentKey,
          lastSyncedAt: n.lastSyncedAt,
          lastError: n.lastError,
          lastCount: n.lastCount,
          syncing: false, // ephemeral
          contentSig: n.contentSig,
        };
      }
      set({ papers, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  reset: () => set({ papers: {}, loaded: false }),

  setEnabled: (arxivId, enabled) =>
    set((s) => {
      const prev = s.papers[arxivId] || DEFAULT_PAPER_SYNC;
      const next: PaperNoteSync = {
        ...prev,
        enabled,
        // clearing the error on enable so a stale failure doesn't linger;
        // on disable we also clear it so the panel stops showing errors.
        lastError: null,
      };
      void api.putNoteSync(arxivId, {
        enabled, lastError: null,
      }).catch(() => { /* non-fatal */ });
      return { papers: { ...s.papers, [arxivId]: next } };
    }),

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
      const noteKey = r.clearKeys ? null : r.noteKey ?? prev.noteKey ?? null;
      const parentKey = r.clearKeys ? null : r.parentKey ?? prev.parentKey ?? null;
      const next: PaperNoteSync = {
        ...prev,
        syncing: false,
        lastSyncedAt: r.error ? prev.lastSyncedAt : Date.now(),
        lastError: r.error ?? null,
        lastCount: r.count,
        noteKey,
        parentKey,
        contentSig: r.contentSig ?? prev.contentSig,
      };
      void api.putNoteSync(arxivId, {
        noteKey, parentKey,
        lastSyncedAt: next.lastSyncedAt,
        lastError: next.lastError,
        lastCount: next.lastCount,
        contentSig: next.contentSig,
      }).catch(() => { /* non-fatal */ });
      return { papers: { ...s.papers, [arxivId]: next } };
    }),
}));
