// Shared types for Little Alphaxiv frontend.

/** A configured LLM provider (OpenAI-compatible). Stored in localStorage. */
export interface Provider {
  id: string;
  name: string;
  base_url: string; // e.g. https://api.openai.com/v1
  api_key: string;
  model: string; // e.g. gpt-4o-mini
  is_default?: boolean;
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
  context_window?: number; // max tokens of conversation history to send (0 = all)
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
}

/** Model info returned by the /api/models endpoint. */
export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
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
  highlight?: { rects: NormRect[] };
  rect?: NormRect;
  draw?: { points: NormPoint[]; width: number }; // width normalized
  text?: { x: number; y: number; w: number; h: number; content: string; fontSize: number };
}

export type Op =
  | { kind: "add"; annot: Annotation }
  | { kind: "remove"; annot: Annotation }
  | { kind: "edit"; before: Annotation; after: Annotation }
  | { kind: "move"; before: Annotation; after: Annotation }
  | { kind: "resize"; before: Annotation; after: Annotation };

export interface PageSize { w: number; h: number; }
