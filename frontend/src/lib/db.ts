// IndexedDB persistence for conversations + cached papers (full text).
// All data lives in the user's browser. No server storage.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, Paper, Annotation } from "../types";
import { migrateAnnotation } from "./annotations";

interface LaxDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
    indexes: { "by-updated": number };
  };
  papers: {
    key: string; // arxiv_id
    value: Paper & { full_text?: string; fetched_at: number };
  };
  annotations: {
    key: string; // annot.id
    value: Annotation;
    indexes: {
      "by-paper": string; // arxiv_id
      "by-paper-page": [string, number]; // [arxiv_id, page]
    };
  };
}

let dbp: Promise<IDBPDatabase<LaxDB>> | null = null;

function db(): Promise<IDBPDatabase<LaxDB>> {
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

// ---- Conversations ----

export async function listConversations(): Promise<Conversation[]> {
  const d = await db();
  const all = await d.getAllFromIndex("conversations", "by-updated");
  return all.sort((a, b) => b.updated_at - a.updated_at);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const d = await db();
  return d.get("conversations", id);
}

export async function saveConversation(c: Conversation): Promise<void> {
  const d = await db();
  await d.put("conversations", c);
}

export async function deleteConversation(id: string): Promise<void> {
  const d = await db();
  await d.delete("conversations", id);
}

// ---- Papers (cache: metadata + extracted full text) ----

export async function getPaper(
  arxivId: string
): Promise<(Paper & { full_text?: string; fetched_at: number }) | undefined> {
  const d = await db();
  return d.get("papers", arxivId);
}

export async function savePaper(
  p: Paper & { full_text?: string; fetched_at: number }
): Promise<void> {
  const d = await db();
  await d.put("papers", p);
}

// ---- Annotations (per-paper PDF annotation layer) ----

export async function listAnnotations(arxivId: string): Promise<Annotation[]> {
  const d = await db();
  const all = await d.getAllFromIndex("annotations", "by-paper", arxivId);
  // Migrate legacy single-stroke `draw.points` annotations to the current
  // multi-stroke `draw.strokes` shape. Idempotent; non-draw annotations pass through.
  return all.map(migrateAnnotation);
}

export async function putAnnotation(a: Annotation): Promise<void> {
  const d = await db();
  await d.put("annotations", a);
}

export async function deleteAnnotation(id: string): Promise<void> {
  const d = await db();
  await d.delete("annotations", id);
}

export async function clearAnnotations(arxivId: string): Promise<void> {
  const d = await db();
  const ids = await d.getAllKeysFromIndex("annotations", "by-paper", arxivId);
  const tx = d.transaction("annotations", "readwrite");
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

// ---- Counts (for the hasHistory signal: "does this origin hold persisted data?") ----

export async function countAnnotations(): Promise<number> {
  const d = await db();
  return d.count("annotations");
}

export async function countPapers(): Promise<number> {
  const d = await db();
  return d.count("papers");
}
