// UI-only state: sidebar collapse + the Open Local Paper dialog. Not persisted
// (ephemeral per session).

import { create } from "zustand";

/** Pre-fill for the Open Local Paper dialog. When the user clicks an
 *  unfetchable PaperCard's "Upload Local PDF" / "Import from Zotero", the
 *  surfaced paper's metadata is passed in so the upload attaches bytes to the
 *  EXISTING global Paper row (no duplicate id) instead of creating a new one. */
export interface LocalPaperPreset {
  paperId?: string;
  title?: string;
  authors?: string[];
  doi?: string;
  externalUrl?: string;
}

export interface LocalPaperDialogState {
  open: boolean;
  preset?: LocalPaperPreset;
  initialTab?: "upload" | "zotero";
}

interface UiState {
  sidebarCollapsed: boolean;
  collapseSidebar: () => void;
  expandSidebar: () => void;
  toggleSidebar: () => void;
  localPaperDialog: LocalPaperDialogState;
  openLocalPaperDialog: (opts?: { preset?: LocalPaperPreset; tab?: "upload" | "zotero" }) => void;
  closeLocalPaperDialog: () => void;
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: false,
  collapseSidebar: () => set({ sidebarCollapsed: true }),
  expandSidebar: () => set({ sidebarCollapsed: false }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  localPaperDialog: { open: false },
  openLocalPaperDialog: (opts) =>
    set({ localPaperDialog: { open: true, preset: opts?.preset, initialTab: opts?.tab } }),
  closeLocalPaperDialog: () => set({ localPaperDialog: { open: false } }),
}));
