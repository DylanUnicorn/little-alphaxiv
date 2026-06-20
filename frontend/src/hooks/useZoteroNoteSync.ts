// "Create Note from Annotations" sync engine. While enabled for the current
// paper (toggled in ZoteroPanel's "This paper" tab), this continuously pushes
// the user's PDF highlights + text notes to a single child note under the
// paper's Zotero item (web API only — the local connector can't attach child
// notes).
//
// It lives in PdfViewer (not ZoteroPanel) because it needs the loaded pdf.js
// document to recover highlight text from rects; the panel only holds the
// enable toggle + status and shares state via the zoteroNoteSync store. The
// engine keeps running as long as the paper view is open, even with the Zotero
// panel closed.
//
// Triggers: an immediate sync on enable; a 45s interval while enabled; a 4s
// debounced sync after annotations change. An in-flight guard prevents
// overlapping runs. All values the async sync reads are kept in a ref so the
// interval/debounce callbacks never see stale state.

import { useCallback, useEffect, useRef } from "react";
import type * as pdfjsLib from "pdfjs-dist";
import { useSettings } from "../store/settings";
import { useAnnotations } from "../store/annotations";
import { useZoteroNoteSyncStore } from "../store/zoteroNoteSync";
import { zoteroStatus, zoteroUpsertNote, type ZoteroCreds } from "../lib/api";
import { makePdfTextResolver } from "../lib/highlightRecovery";
import {
  ANNOT_NOTE_TAG,
  findZoteroPaperKey,
  gatherNoteEntries,
  renderNoteHtml,
} from "../lib/zoteroNote";
import * as db from "../lib/db";

const SYNC_INTERVAL_MS = 45_000;
const DEBOUNCE_MS = 4_000;

export function useZoteroNoteSync(
  arxivId: string,
  doc: pdfjsLib.PDFDocumentProxy | null
): void {
  const zotero = useSettings((s) => s.zotero);
  const annots = useAnnotations((s) => s.annots);
  const sync = useZoteroNoteSyncStore((s) => s.papers[arxivId]);
  const beginSync = useZoteroNoteSyncStore((s) => s.beginSync);
  const finishSync = useZoteroNoteSyncStore((s) => s.finishSync);

  const enabled = !!sync?.enabled;

  // Latest values for the async sync (avoids stale closures in the interval).
  const latest = useRef({ zotero, annots, doc, sync });
  latest.current = { zotero, annots, doc, sync };
  const runningRef = useRef(false);
  // Cached connectivity + resolved mode, invalidated when creds change so a
  // settings edit (mode/userId/apiKey) re-checks. Avoids hitting zoteroStatus
  // on every 45s tick.
  const modeRef = useRef<{ creds: ZoteroCreds; mode: string } | null>(null);

  const doSync = useCallback(async () => {
    if (runningRef.current) return;
    const st = latest.current;
    if (!st.sync?.enabled) return;
    const creds: ZoteroCreds = {
      mode: st.zotero.mode,
      userId: st.zotero.userId,
      apiKey: st.zotero.apiKey,
    };

    runningRef.current = true;
    beginSync(arxivId);
    try {
      // Resolve connection + mode (cached per creds). Web is required: the
      // local Zotero connector cannot attach child notes (see backend).
      const cached = modeRef.current;
      const sameCreds =
        cached &&
        cached.creds.userId === creds.userId &&
        cached.creds.apiKey === creds.apiKey &&
        cached.creds.mode === creds.mode;
      if (!sameCreds) {
        const res = await zoteroStatus(creds);
        if (!res.ok) {
          finishSync(arxivId, {
            count: 0,
            error: `Zotero not connected: ${res.error || "offline"}`,
          });
          return;
        }
        modeRef.current = { creds, mode: res.mode };
      }
      const mode = modeRef.current!.mode;
      if (mode !== "web") {
        finishSync(arxivId, {
          count: 0,
          error: `Note sync requires Web API mode (current: ${mode}).`,
        });
        return;
      }

      const paper = await db.getPaper(arxivId);
      // Find the paper's Zotero item (cached parent key; re-search on miss).
      let parentKey = st.sync?.parentKey || "";
      if (!parentKey) {
        parentKey = await findZoteroPaperKey(creds, arxivId, paper?.title || "");
      }
      if (!parentKey) {
        finishSync(arxivId, {
          count: 0,
          error: "Paper not in Zotero — add it (This paper tab) first.",
        });
        return;
      }

      // Gather annotations + build the note. Highlights created since this
      // feature carry their selected text; older ones (and rects) fall back to
      // pdf.js text-layer recovery.
      const resolver = makePdfTextResolver(st.doc);
      const entries = await gatherNoteEntries(st.annots, resolver);
      const html = renderNoteHtml(paper, entries, Date.now());

      // Upsert (create-or-update) the tagged child note. The backend patches
      // the cached noteKey if still valid, else discovers by tag, else creates.
      const res = await zoteroUpsertNote(creds, parentKey, html, {
        noteKey: st.sync?.noteKey || undefined,
        tag: ANNOT_NOTE_TAG,
      });
      if (!res.ok || !res.key) {
        // A stale cached key is already retried server-side (tag discovery);
        // if it still failed, drop the caches so the next run rediscovers.
        finishSync(arxivId, {
          count: entries.length,
          error: res.error || "sync failed",
          clearKeys: true,
        });
        return;
      }
      finishSync(arxivId, { noteKey: res.key, parentKey, count: entries.length });
    } catch (e) {
      finishSync(arxivId, { count: 0, error: String((e as Error).message || e) });
    } finally {
      runningRef.current = false;
    }
  }, [arxivId, beginSync, finishSync]);

  // Immediate sync when the user enables the feature.
  useEffect(() => {
    if (enabled) void doSync();
    // `doSync` reads live state via refs; only `enabled` should retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Periodic sync while enabled and the paper view is open.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => void doSync(), SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, doSync]);

  // Debounced sync shortly after annotations change (add/edit/remove a
  // highlight or text note). `annots` identity changes only on real mutation,
  // so this resets the timer per change and fires once edits settle.
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => void doSync(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [enabled, annots, doSync]);
}
