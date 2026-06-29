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
  noteContentSignature,
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

    // Default is enabled (see store). But the feature is meaningless without
    // Web API creds — a paper whose row defaulted on can't run yet. Treat
    // that as a silent no-op (no error surfaced, no state churn) rather than
    // a scary "not connected" error, so a user who hasn't set up Zotero is
    // never bothered. The checkbox in the panel is disabled until web mode
    // connects anyway; this just keeps the background engine quiet.
    const hasWebCreds = creds.mode === "web" && !!creds.userId && !!creds.apiKey;
    if (creds.mode !== "auto" && !hasWebCreds) return;

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
          // Auto-mode silently skips when Zotero is unreachable (the user
          // may not have it running); only surface a hard failure for an
          // explicitly-configured web setup.
          if (creds.mode === "web") {
            finishSync(arxivId, {
              count: 0,
              error: `Zotero not connected: ${res.error || "offline"}`,
            });
          }
          return;
        }
        modeRef.current = { creds, mode: res.mode };
      }
      const mode = modeRef.current!.mode;
      if (mode !== "web") {
        // Auto-mode resolved to local: notes aren't possible there. Silent
        // skip (same rationale as above) unless the user explicitly chose web.
        if (creds.mode === "web") {
          finishSync(arxivId, {
            count: 0,
            error: `Note sync requires Web API mode (current: ${mode}).`,
          });
        }
        return;
      }

      const paper = await db.getPaper(arxivId);
      // Find the paper's Zotero item (cached parent key; re-search on miss).
      let parentKey = st.sync?.parentKey || "";
      if (!parentKey) {
        parentKey = await findZoteroPaperKey(creds, arxivId, paper?.title || "");
      }
      if (!parentKey) {
        // The paper isn't in Zotero yet. This is expected when "Create Note"
        // is on by default but the user hasn't added the paper. Surface it as
        // an informational status (not a scary error) so they know the next
        // step, but only once a sync actually has something to push — i.e.
        // only when there are annotations. No annotations → silent.
        const resolver0 = makePdfTextResolver(st.doc);
        const entries0 = await gatherNoteEntries(st.annots, resolver0);
        if (entries0.length === 0) return;
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

      // Content-signature skip: the rendered HTML carries a wall-clock
      // timestamp, so byte-identical annotations still produce different HTML
      // each run. Comparing a timestamp-independent signature of the *content*
      // lets us skip the PATCH entirely when nothing changed — which is what
      // keeps the note's server version from bumping every 45s and tripping
      // Zotero desktop's local-vs-remote conflict dialog. We still treat the
      // skip as a success (refresh lastSyncedAt + persist the sig) so the
      // status line reflects "up to date" and future runs keep skipping.
      const sig = noteContentSignature(paper, entries);
      if (sig && sig === st.sync?.contentSig) {
        finishSync(arxivId, {
          noteKey: st.sync.noteKey || undefined,
          parentKey,
          count: entries.length,
          contentSig: sig,
        });
        return;
      }

      // Upsert (create-or-update) the tagged child note. The backend patches
      // the cached noteKey if still valid, else discovers by tag, else creates.
      const res = await zoteroUpsertNote(creds, parentKey, html, {
        noteKey: st.sync?.noteKey || undefined,
        tag: ANNOT_NOTE_TAG,
      });
      if (!res.ok || !res.key) {
        // A stale cached key is already retried server-side (tag discovery);
        // if it still failed, drop the caches (and the signature) so the next
        // run rediscovers and does a real rewrite.
        finishSync(arxivId, {
          count: entries.length,
          error: res.error || "sync failed",
          clearKeys: true,
        });
        return;
      }
      finishSync(arxivId, {
        noteKey: res.key,
        parentKey,
        count: entries.length,
        contentSig: sig,
      });
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
