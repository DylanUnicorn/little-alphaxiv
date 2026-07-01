// Shared types for Little Alphaxiv frontend.

/** A configured LLM provider (OpenAI-compatible). Stored in localStorage. */
export interface Provider {
  id: string;
  name: string;
  base_url: string; // e.g. https://api.openai.com/v1
  api_key: string;
  model: string; // e.g. gpt-4o-mini
  is_default?: boolean;
  /** Optional vision-capable model id on the SAME provider (same base_url +
   *  api_key). When set, the chat panel auto-routes any turn whose context
   *  includes an image to this model if the current model isn't vision-capable.
   *  Undefined = no vision fallback configured for this provider. */
  vision_model?: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

/** An image attachment pasted/uploaded by the user. Stored as data URL in the
 *  message; sent to the model as an image_url content part. */
export interface Attachment {
  type: "image";
  data_url: string; // base64 data URL
  name?: string;
}

/** A chat message. Mirrors OpenAI chat-completion message shape, plus our
 *  UI-only fields (tool results are rendered as paper cards client-side). */
export interface ChatMessage {
  role: Role;
  content: string | null;
  // For user messages with attachments, content is the text and attachments
  // hold the images. When building API messages, we convert to OpenAI
  // multimodal content array format.
  attachments?: Attachment[];
  // assistant tool calls
  tool_calls?: ToolCall[];
  // tool result message fields
  tool_call_id?: string;
  name?: string;
  // UI metadata (not sent to model in this exact form)
  ui?: {
    papers?: Paper[]; // papers surfaced from a search_arxiv tool result
    pending?: boolean; // assistant message still streaming
    error?: string;
    stopped?: boolean; // user clicked Stop mid-reply; partial content kept, "已停止" marker
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface Paper {
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string;
  pdf_url: string;
  abs_url: string;
  published: string;
  primary_category: string;
  /** Which search source surfaced this paper. arXiv results omit it (legacy).
   *  "upload" / "zotero" mark user-private papers brought in via the Open Local
   *  Paper dialog (their PDF bytes live server-side, per-user). */
  source?: "arxiv" | "openalex" | "s2" | "upload" | "zotero";
  /** DOI (lowercased, no URL wrapper) when the source provides one. */
  doi?: string;
  /** Direct open-access PDF URL for non-arXiv papers, when available. */
  oa_pdf_url?: string;
  /** Landing page (DOI/S2/OpenAlex) for papers with no in-app-previewable PDF. */
  external_url?: string;
}

export type ConversationType = "general" | "paper";

/** Style presets that modify the system prompt and assistant behavior. */
export type StylePreset = "default" | "thorough" | "tutor" | "skeptical";

export interface Conversation {
  id: string;
  title: string;
  type: ConversationType;
  paper_id?: string; // arxiv_id when type === "paper"
  provider_id?: string;
  model?: string; // per-conversation model override (falls back to provider default)
  style_preset?: StylePreset; // per-conversation style preset
  /** DEPRECATED — legacy message-count history cap. Unread since the
   *  context-usage-ring feature; left dormant in IndexedDB, never migrated.
   *  Replaced by context_capacity_override + reserve_tokens (token-based). */
  context_window?: number;
  /** Per-conversation total context-capacity override in tokens.
   *  0 / undefined = Auto (resolve from model: provider-reported context_length
   *  → curated table → 128K default). See lib/contextBudget.resolveCapacity. */
  context_capacity_override?: number;
  /** Per-conversation reserved output budget in tokens (held back for the
   *  reply so the ring's "usable" = capacity − reserve).
   *  0 / undefined = auto default (12.5% of capacity, floored 4K, capped 64K). */
  reserve_tokens?: number;
  /** Last turn's real usage reported by the provider, used to calibrate the
   *  heuristic token estimate so the ring's "used" tracks ground truth. */
  last_usage?: TokenUsage & {
    /** real.prompt_tokens / heuristicEstimate(that turn), clamped [0.3, 3.0].
     *  1.0 before any real usage. */
    calibration: number;
    ts: number;
  };
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
}

/** Token usage reported by an OpenAI-compatible provider (the `usage` object on
 *  a chat-completion response, or the final chunk of a stream). Used to
 *  calibrate the heuristic token estimate behind the context-usage ring. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Model info returned by the /api/models endpoint. */
export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  /** Total context window in tokens, if the provider's /v1/models reports it
   *  (e.g. some OpenAI-compatible gateways). Picked from context_length /
   *  max_context_tokens / max_input_tokens by the fetchModels normalizer.
   *  Undefined when the provider doesn't expose it — capacity then resolves via
   *  the curated KNOWN_MODEL_CONTEXT table or the 128K default. */
  context_length?: number;
}

/** Style preset definitions with their system prompt modifiers. */
export const STYLE_PRESETS: Record<
  StylePreset,
  { label: string; icon: string; description: string; promptMod: string }
> = {
  default: {
    label: "Default",
    icon: "💬",
    description: "Balanced, concise answers",
    promptMod: "",
  },
  thorough: {
    label: "Thorough",
    icon: "🔬",
    description: "Detailed, comprehensive analysis",
    promptMod:
      "\n\nBe thorough and comprehensive in your analysis. Provide detailed explanations, include relevant context, and consider edge cases. When discussing papers, cover methodology, results, limitations, and implications in depth.",
  },
  tutor: {
    label: "Tutor",
    icon: "🎓",
    description: "Socratic, teaches as you go",
    promptMod:
      "\n\nAct as a patient tutor. Explain concepts step by step, check understanding, use analogies, and guide the user to deeper insight. If the user seems confused, break things down further. Ask clarifying questions when helpful.",
  },
  skeptical: {
    label: "Skeptical",
    icon: "🔍",
    description: "Critical, questions assumptions",
    promptMod:
      "\n\nBe a critical and skeptical reader. Question assumptions, identify potential flaws in methodology or reasoning, point out missing controls or alternative explanations, and distinguish what the paper claims from what the evidence actually supports. Don't be afraid to disagree.",
  },
};

// ---------- PDF annotations ----------

export type AnnotationType = "highlight" | "rect" | "draw" | "text";
export type Tool = "none" | "text" | "rect" | "draw" | "highlight";

/** Page-normalized rect (0..1 relative to page width/height). */
export interface NormRect { x: number; y: number; w: number; h: number; }
/** Page-normalized point (0..1). */
export interface NormPoint { x: number; y: number; }

export interface Annotation {
  id: string;
  arxiv_id: string;
  page: number; // 1-based
  type: AnnotationType;
  color: string; // hex from PALETTE
  createdAt: number;
  highlight?: { rects: NormRect[]; content?: string };
  rect?: NormRect;
  draw?: { strokes: NormPoint[][]; width: number }; // each stroke = NormPoint[]; one annotation = one freehand session (width normalized)
  text?: { x: number; y: number; w: number; h: number; content: string; fontSize: number };
}

export type Op =
  | { kind: "add"; annot: Annotation }
  | { kind: "remove"; annot: Annotation }
  | { kind: "edit"; before: Annotation; after: Annotation }
  | { kind: "move"; before: Annotation; after: Annotation }
  | { kind: "resize"; before: Annotation; after: Annotation };

export interface PageSize { w: number; h: number; }
