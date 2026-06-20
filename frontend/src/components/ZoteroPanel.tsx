// ZoteroPanel — overlay triggered from the PDF toolbar Zotero icon.
// Three tabs:
//   - "This paper": find the current arXiv paper in the Zotero library (by
//     arXiv id, falling back to title). If found, open it in Zotero via the
//     zotero://select deep link; if not, add it (metadata + optional PDF).
//   - "Library": search the library; open any item in Zotero.
//   - "Collections": list collections; click a collection to expand it and see
//     the papers inside (works in both local and web mode — reading items is
//     allowed on the read-only local API). In Web mode, also create a
//     collection or add the current paper to one (organize). Local mode can't
//     organize — the panel says so.
//
// All Zotero calls go through /api/zotero/* (backend proxy → local 23119 or
// web api.zotero.org). Credentials come from the settings store.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../store/settings";
import { ensurePaperMeta } from "../lib/paperMeta";
import {
  zoteroStatus,
  zoteroSearchItems,
  zoteroListCollections,
  zoteroListCollectionItems,
  zoteroSaveArxiv,
  zoteroCreateCollection,
  zoteroAddToCollection,
  zoteroGetSelectedCollection,
  zoteroSelectUrl,
  type ZoteroItem,
  type ZoteroCollection,
} from "../lib/api";
import type { Paper } from "../types";

interface Props {
  arxivId: string;
  onClose: () => void;
}

type Tab = "paper" | "library" | "collections";

/** Strip a trailing version so 2401.07041v1 matches 2401.07041. */
function normArxiv(id: string): string {
  return (id || "").trim().replace(/v\d+$/, "").toLowerCase();
}

export function ZoteroPanel({ arxivId, onClose }: Props) {
  const zotero = useSettings((s) => s.zotero);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("paper");
  const [paper, setPaper] = useState<Paper | null>(null);

  const [status, setStatus] = useState<{ ok: boolean; mode: string; library?: string; error?: string } | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);

  // "This paper" tab state
  const [found, setFound] = useState<ZoteroItem[]>([]);
  const [searchingPaper, setSearchingPaper] = useState(false);
  const [attachPdf, setAttachPdf] = useState(true);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Collection chosen for the add-new-paper flow (web mode only — local mode
  // can't target a collection, so we show the desktop's current selection
  // instead via localTarget). "" means My Library (no collection).
  const [paperColl, setPaperColl] = useState("");
  const [localTarget, setLocalTarget] = useState<{ libraryName: string; collectionName: string } | null>(null);

  // "Library" tab state
  const [libQuery, setLibQuery] = useState("");
  const [libResults, setLibResults] = useState<ZoteroItem[]>([]);
  const [libSearching, setLibSearching] = useState(false);

  // "Collections" tab state
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [collLoaded, setCollLoaded] = useState(false);
  const [selectedColl, setSelectedColl] = useState("");
  const [newCollName, setNewCollName] = useState("");
  const [collBusy, setCollBusy] = useState(false);
  // Expand-a-collection-to-see-its-items state. One collection expanded at a
  // time; items are lazy-loaded on first expand and cached so toggling back and
  // forth doesn't re-hit Zotero. collFilter narrows the expanded list by title.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [collItems, setCollItems] = useState<Record<string, ZoteroItem[]>>({});
  const [collLoading, setCollLoading] = useState<string | null>(null);
  const [collFilter, setCollFilter] = useState("");
  const [collError, setCollError] = useState<string | null>(null);

  const creds = useMemo(() => ({ mode: zotero.mode, userId: zotero.userId, apiKey: zotero.apiKey }), [zotero]);
  const connected = !!status?.ok;
  const webMode = status?.mode === "web";

  // Load paper metadata + check connection on open. ensurePaperMeta fetches real
  // arXiv metadata if the cached record is a bare-id stub (direct-URL nav), so
  // the panel header and the "Add to Zotero" payload carry the real title /
  // authors / abstract / DOI rather than the bare id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await ensurePaperMeta(arxivId);
      if (!cancelled) setPaper(p ?? null);
    })();
    (async () => {
      setCheckingStatus(true);
      try {
        const res = await zoteroStatus(creds);
        if (!cancelled) setStatus(res);
      } catch (e) {
        if (!cancelled) setStatus({ ok: false, mode: zotero.mode, error: String((e as Error).message || e) });
      } finally {
        if (!cancelled) setCheckingStatus(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arxivId]);

  // Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Search the library for the current paper (by arXiv id, then title).
  const findCurrentPaper = useCallback(async () => {
    if (!connected) return;
    setSearchingPaper(true);
    setMsg(null);
    try {
      const matches: ZoteroItem[] = [];
      const seen = new Set<string>();
      const add = (items: ZoteroItem[]) => {
        for (const it of items) {
          if (!seen.has(it.key)) { seen.add(it.key); matches.push(it); }
        }
      };
      if (arxivId) {
        const r = await zoteroSearchItems(creds, arxivId, 25);
        add(r.results.filter((it) => normArxiv(it.arxivId) === normArxiv(arxivId)));
      }
      if (matches.length === 0 && paper?.title) {
        const r = await zoteroSearchItems(creds, paper.title.slice(0, 80), 25);
        add(r.results.filter((it) => it.title.trim().toLowerCase() === (paper.title || "").trim().toLowerCase()));
      }
      setFound(matches);
    } catch (e) {
      setMsg({ kind: "err", text: `Search failed: ${String((e as Error).message || e)}` });
    } finally {
      setSearchingPaper(false);
    }
  }, [arxivId, connected, creds, paper]);

  useEffect(() => {
    if (connected && tab === "paper" && found.length === 0 && !searchingPaper) {
      void findCurrentPaper();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, tab]);

  const currentKey = found[0]?.key || "";

  async function addToZotero() {
    setAdding(true);
    setMsg(null);
    try {
      // Guarantee complete metadata even if the panel opened before the arXiv
      // fetch finished, or the cached record is still a bare-id stub. The
      // backend re-fetches too (belt-and-suspenders), but doing it here also
      // updates the header so the user sees the real title post-add.
      const enriched = await ensurePaperMeta(arxivId);
      if (enriched) setPaper(enriched);
      const p = enriched ?? paper;
      // Web mode: target the chosen collection at creation (reliable). Local
      // mode: collectionKeys is ignored by the connector — the item lands in
      // the desktop's selected collection (shown above as localTarget).
      const collKeys = paperColl ? [paperColl] : [];
      const res = await zoteroSaveArxiv(
        creds,
        {
          arxiv_id: arxivId,
          title: p?.title ?? "",
          authors: p?.authors ?? [],
          doi: p?.doi ?? "",
          abstract: p?.abstract ?? "",
          abs_url: p?.abs_url || (arxivId ? `https://arxiv.org/abs/${arxivId}` : ""),
          pdf_url: p?.pdf_url ?? "",
          published: p?.published ?? "",
          primary_category: p?.primary_category ?? "",
        },
        attachPdf && status?.mode === "local",
        collKeys
      );
      if (res.ok) {
        const bits = [`Added to Zotero (${res.mode})`];
        // Name the target collection so the user sees where it landed.
        if (res.mode === "web" && paperColl) {
          const c = collections.find((x) => x.key === paperColl);
          if (c) bits.push(`→ ${c.name}`);
        } else if (res.mode === "local" && localTarget?.collectionName) {
          bits.push(`→ ${localTarget.collectionName}`);
        }
        if (res.pdfAttached) bits.push("PDF attached");
        else if (attachPdf && res.mode === "local") bits.push("PDF not attached");
        if (res.noteAdded) bits.push("note added");
        setMsg({ kind: "ok", text: bits.join(" · ") + (res.key ? " — opening…" : "") });
        if (res.key) {
          const shownTitle = p?.title && p.title !== arxivId ? p.title : arxivId;
          setFound([{ key: res.key, title: shownTitle, creators: (p?.authors ?? []).join("; "), itemType: "preprint", year: (p?.published ?? "").slice(0, 4), date: p?.published ?? "", url: p?.abs_url ?? "", doi: p?.doi ?? "", arxivId, abstract: p?.abstract ?? "", collections: paperColl ? [paperColl] : [], tags: p?.primary_category ? [p.primary_category] : [] }]);
          // Best-effort: open it in Zotero right away.
          window.open(zoteroSelectUrl(res.key), "_blank", "noopener");
        }
      } else {
        setMsg({ kind: "err", text: "Add failed" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: `Add failed: ${String((e as Error).message || e)}` });
    } finally {
      setAdding(false);
    }
  }

  async function searchLibrary(q: string) {
    setLibSearching(true);
    try {
      const r = await zoteroSearchItems(creds, q, 50);
      setLibResults(r.results);
    } catch (e) {
      setMsg({ kind: "err", text: `Search failed: ${String((e as Error).message || e)}` });
    } finally {
      setLibSearching(false);
    }
  }

  async function loadCollections(force = false) {
    if (!connected || (collLoaded && !force)) return;
    try {
      const r = await zoteroListCollections(creds);
      setCollections(r.results);
    } catch (e) {
      setMsg({ kind: "err", text: `Collections failed: ${String((e as Error).message || e)}` });
    } finally {
      setCollLoaded(true);
    }
  }

  // Expand/collapse a collection row. On first expand, fetch the collection's
  // items (the backend /api/zotero/items endpoint already routes
  // collection_key -> /users/<seg>/collections/<key>/items) and cache them so
  // toggling back and forth doesn't re-hit Zotero. Works in both local and web
  // mode since reading items is allowed on the local read-only API.
  async function toggleCollection(key: string) {
    if (expandedKey === key) {
      setExpandedKey(null);
      setCollFilter("");
      return;
    }
    setExpandedKey(key);
    setCollFilter("");
    setCollError(null);
    if (collItems[key]) return;
    setCollLoading(key);
    try {
      const r = await zoteroListCollectionItems(creds, key, 100);
      setCollItems((prev) => ({ ...prev, [key]: r.results }));
    } catch (e) {
      setCollError(String((e as Error).message || e));
    } finally {
      setCollLoading(null);
    }
  }

  // Load collections for the Collections tab and for the add-paper collection
  // selector (web mode). Idempotent via collLoaded so a zero-collection library
  // doesn't refetch forever; createCollection forces a refresh.
  useEffect(() => {
    if (!connected || collLoaded) return;
    if (tab === "collections" || (tab === "paper" && webMode)) void loadCollections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, tab, webMode, collLoaded]);

  // Local mode: surface the Zotero desktop's currently-selected collection so
  // the user sees where a new item will land (the connector can't target one,
  // so we show the desktop's GUI selection instead of a chooser).
  useEffect(() => {
    if (!connected || status?.mode !== "local" || tab !== "paper") return;
    let cancelled = false;
    void zoteroGetSelectedCollection(creds)
      .then((r) => {
        if (!cancelled && r.ok) {
          setLocalTarget({ libraryName: r.libraryName || "", collectionName: r.collectionName || "" });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, status?.mode, tab]);

  async function createCollection() {
    if (!newCollName.trim()) return;
    setCollBusy(true);
    setMsg(null);
    try {
      const res = await zoteroCreateCollection(creds, newCollName.trim());
      if (res.ok) {
        setNewCollName("");
        await loadCollections(true);
        setMsg({ kind: "ok", text: "Collection created" });
      } else setMsg({ kind: "err", text: "Create failed" });
    } catch (e) {
      setMsg({ kind: "err", text: `Create failed: ${String((e as Error).message || e)}` });
    } finally {
      setCollBusy(false);
    }
  }

  async function addToCollection() {
    if (!selectedColl || !currentKey) return;
    setCollBusy(true);
    setMsg(null);
    try {
      const res = await zoteroAddToCollection(creds, currentKey, [selectedColl]);
      if (res.ok) {
        // Item counts changed — drop the per-collection item cache so the next
        // expand refetches, and refresh the collection list for numItems.
        setCollItems({});
        await loadCollections();
        setMsg({ kind: "ok", text: "Added to collection" });
      } else setMsg({ kind: "err", text: "Add to collection failed" });
    } catch (e) {
      setMsg({ kind: "err", text: `${String((e as Error).message || e)}` });
    } finally {
      setCollBusy(false);
    }
  }

  const statusChip = checkingStatus
    ? "checking…"
    : connected
      ? `● ${status!.mode}${status!.library ? ` · ${status!.library}` : ""}`
      : "✗ offline";

  return (
    <div className="zotero-overlay" onClick={onClose}>
      <div className="zotero-panel" onClick={(e) => e.stopPropagation()}>
        <div className="zotero-head">
          <strong>Zotero</strong>
          <span className={`zotero-chip ${connected ? "on" : "off"}`}>{statusChip}</span>
          <button className="zotero-close" onClick={onClose} title="Close">×</button>
        </div>

        {!connected && !checkingStatus && (
          <div className="zotero-banner">
            Zotero isn’t reachable ({status?.error || "offline"}).{" "}
            {zotero.mode !== "web"
              ? "Start the Zotero desktop app and enable “Allow other applications to communicate with Zotero” (Preferences → Advanced), or "
              : "Check your user ID / API key, or "}
            <a
              href="/settings#zotero"
              onClick={(e) => { e.preventDefault(); onClose(); navigate("/settings#zotero"); }}
            >open Settings</a> to switch to Web API mode.
          </div>
        )}

        <div className="zotero-tabs">
          <button className={tab === "paper" ? "active" : ""} onClick={() => setTab("paper")}>This paper</button>
          <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")} disabled={!connected}>Library</button>
          <button className={tab === "collections" ? "active" : ""} onClick={() => setTab("collections")} disabled={!connected}>Collections</button>
        </div>

        {msg && <div className={`zotero-msg ${msg.kind}`}>{msg.text}</div>}

        <div className="zotero-body">
          {tab === "paper" && (
            <div className="zotero-tab">
              <div className="zotero-paper-title">{paper?.title || arxivId}</div>
              {paper?.authors?.length ? <div className="zotero-paper-authors">{paper.authors.join(", ")}</div> : null}
              <div className="zotero-paper-id">arXiv:{arxivId}{paper?.primary_category ? ` · ${paper.primary_category}` : ""}{paper?.doi ? ` · DOI:${paper.doi}` : ""}</div>

              {!connected ? (
                <div className="zotero-hint">Connect Zotero to search your library.</div>
              ) : searchingPaper ? (
                <div className="zotero-hint">Searching your Zotero library…</div>
              ) : found.length > 0 ? (
                <div className="zotero-found">
                  <div className="zotero-hint">✓ Found in your Zotero library:</div>
                  {found.map((it) => (
                    <div key={it.key} className="zotero-item">
                      <div className="zotero-item-main">
                        <span className="zotero-item-title">{it.title}</span>
                        {it.creators && <span className="zotero-item-sub">{it.creators}{it.year ? ` (${it.year})` : ""}</span>}
                      </div>
                      <a className="zotero-open-btn" href={zoteroSelectUrl(it.key)} target="_blank" rel="noopener noreferrer">Open in Zotero</a>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="zotero-notfound">
                  <div className="zotero-hint">Not in your Zotero library yet.</div>

                  {webMode ? (
                    <label className="zotero-coll-pick">
                      <span className="zotero-coll-pick-label">Save to collection</span>
                      <select
                        value={paperColl}
                        onChange={(e) => setPaperColl(e.target.value)}
                        disabled={!collLoaded}
                        title="Choose a collection (My Library = no collection)"
                      >
                        <option value="">My Library</option>
                        {collections.map((c) => (
                          <option key={c.key} value={c.key}>{c.name} ({c.numItems})</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className="zotero-target">
                      <span className="zotero-hint">
                        Saving to: <strong>{localTarget?.collectionName || "…"}</strong>
                      </span>
                      <span className="zotero-hint">
                        Local mode saves into the collection selected in the Zotero app — change it
                        there, or <a
                          href="#"
                          onClick={(e) => { e.preventDefault(); onClose(); navigate("/settings#zotero"); }}
                        >switch to Web API</a> to choose here.
                      </span>
                    </div>
                  )}

                  {status?.mode === "local" && (
                    <label className="zotero-check">
                      <input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} />
                      Also save the PDF
                    </label>
                  )}
                  <button className="zotero-add-btn" onClick={addToZotero} disabled={adding}>
                    {adding ? "Adding…" : "Add to Zotero"}
                  </button>
                  {status?.mode === "local" && (
                    <div className="zotero-hint zotero-hint-sub">Saves title, authors, arXiv id, date, DOI, abstract, category. Attached notes (笔记) require <a href="/settings#zotero" onClick={(e) => { e.preventDefault(); onClose(); navigate("/settings#zotero"); }}>Web API mode</a> — the local Zotero connector can't link child notes.</div>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === "library" && (
            <div className="zotero-tab">
              <form
                className="zotero-search"
                onSubmit={(e) => { e.preventDefault(); if (libQuery.trim()) void searchLibrary(libQuery.trim()); }}
              >
                <input
                  placeholder="Search your Zotero library…"
                  value={libQuery}
                  onChange={(e) => setLibQuery(e.target.value)}
                  autoFocus
                />
                <button type="submit" disabled={libSearching || !libQuery.trim()}>{libSearching ? "…" : "Search"}</button>
              </form>
              {libResults.length > 0 ? (
                <div className="zotero-list">
                  {libResults.map((it) => (
                    <div key={it.key} className="zotero-item">
                      <div className="zotero-item-main">
                        <span className="zotero-item-title">{it.title}</span>
                        {it.creators && <span className="zotero-item-sub">{it.creators}{it.year ? ` (${it.year})` : ""}</span>}
                      </div>
                      <a className="zotero-open-btn" href={zoteroSelectUrl(it.key)} target="_blank" rel="noopener noreferrer">Open</a>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="zotero-hint">{libQuery ? "No results." : "Search by title, author, or any field."}</div>
              )}
            </div>
          )}

          {tab === "collections" && (
            <div className="zotero-tab">
              {!webMode ? (
                <div className="zotero-hint">
                  Organizing collections (create / add to) requires <strong>Web API</strong> mode —
                  the local Zotero API is read-only by design.{" "}
                  <a
                    href="/settings#zotero"
                    onClick={(e) => { e.preventDefault(); onClose(); navigate("/settings#zotero"); }}
                  >Switch in Settings</a>. You can still browse your collections
                  and the papers inside each one (read-only):
                </div>
              ) : (
                <div className="zotero-coll-actions">
                  <div className="zotero-coll-row">
                    <select value={selectedColl} onChange={(e) => setSelectedColl(e.target.value)} disabled={!collections.length}>
                      <option value="">{collections.length ? "Select a collection…" : "No collections"}</option>
                      {collections.map((c) => <option key={c.key} value={c.key}>{c.name} ({c.numItems})</option>)}
                    </select>
                    <button onClick={addToCollection} disabled={collBusy || !selectedColl || !currentKey}>
                      Add current paper
                    </button>
                  </div>
                  <div className="zotero-coll-row">
                    <input placeholder="New collection name…" value={newCollName} onChange={(e) => setNewCollName(e.target.value)} />
                    <button onClick={createCollection} disabled={collBusy || !newCollName.trim()}>Create</button>
                  </div>
                  {!currentKey && <div className="zotero-hint">Find the current paper first (This paper tab) to add it to a collection.</div>}
                </div>
              )}
              {collections.length > 0 ? (
                <div className="zotero-list">
                  {collections.map((c) => {
                    const open = expandedKey === c.key;
                    // Notes/attachments slip into the collection-items endpoint;
                    // hide them so the list shows real papers only.
                    const raw = (collItems[c.key] || []).filter(
                      (it) => it.itemType !== "note" && it.itemType !== "attachment"
                    );
                    const q = collFilter.trim().toLowerCase();
                    const shown = q ? raw.filter((it) => it.title.toLowerCase().includes(q)) : raw;
                    return (
                      <div key={c.key} className="zotero-coll-wrap">
                        <button
                          className={`zotero-coll-item ${open ? "open" : ""}`}
                          onClick={() => void toggleCollection(c.key)}
                          aria-expanded={open}
                        >
                          <span className="zotero-coll-caret">{open ? "▼" : "▶"}</span>
                          <span className="zotero-coll-name">{c.parentKey ? "↳ " : "📁 "}{c.name}</span>
                          <span className="zotero-coll-count">{c.numItems}</span>
                        </button>
                        {open && (
                          <div className="zotero-coll-items">
                            {collLoading === c.key ? (
                              <div className="zotero-hint">Loading items…</div>
                            ) : collError ? (
                              <div className="zotero-hint">Failed to load: {collError}</div>
                            ) : raw.length === 0 ? (
                              <div className="zotero-hint">No items in this collection.</div>
                            ) : (
                              <>
                                <input
                                  className="zotero-coll-filter"
                                  placeholder={`Filter ${raw.length} item${raw.length === 1 ? "" : "s"} by title…`}
                                  value={collFilter}
                                  onChange={(e) => setCollFilter(e.target.value)}
                                />
                                {shown.map((it) => (
                                  <div key={it.key} className="zotero-item zotero-coll-entry">
                                    <div className="zotero-item-main">
                                      <span className="zotero-item-title">
                                        {it.title}
                                        {it.arxivId && <span className="zotero-arxiv-badge" title={`arXiv:${it.arxivId}`}>arXiv</span>}
                                      </span>
                                      {it.creators && <span className="zotero-item-sub">{it.creators}{it.year ? ` (${it.year})` : ""}</span>}
                                    </div>
                                    <a className="zotero-open-btn" href={zoteroSelectUrl(it.key)} target="_blank" rel="noopener noreferrer">Open</a>
                                  </div>
                                ))}
                                {shown.length === 0 && <div className="zotero-hint">No matches.</div>}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                connected && <div className="zotero-hint">No collections.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
