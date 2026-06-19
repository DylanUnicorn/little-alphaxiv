// Vision-capability detection + the auto-fallback decision for image input.
//
// Pure functions only: no React, no IO, no store imports. Fully unit-testable
// (see visionFallback.test.ts), same discipline as lib/contextBudget.ts.
//
// Consumer: components/ChatPanel.tsx calls resolveVisionFallback() before each
// turn. When the about-to-be-sent context carries an image and the current
// model is not vision-capable, it routes to the provider's configured
// vision_model (same base_url + api_key, just a different model id).

/** Curated name patterns for models that accept image input. First substring
 *  match (case-insensitive, array order) wins — list more-specific prefixes
 *  before shorter ones. Low-maintenance, mirrors the KNOWN_MODEL_CONTEXT
 *  approach in lib/contextBudget.ts. Unknown ids are treated as NON-vision
 *  (eligible for the auto-swap), which only routes to the user's explicitly
 *  configured vision model — the intended behavior. */
export const VISION_CAPABLE: { match: string }[] = [
  { match: "gpt-4o" },
  { match: "gpt-4.1" },
  { match: "gpt-4-turbo" },
  { match: "gpt-4-vision" },
  { match: "gpt-4.5" },
  { match: "gpt-5" },
  { match: "gemini" }, // all Gemini variants are multimodal
  { match: "claude-3" },
  { match: "claude-sonnet" },
  { match: "claude-opus" },
  { match: "claude-haiku" },
  { match: "glm-4v" },
  { match: "qwen-vl" },
  { match: "qwen2-vl" },
  { match: "qwen2.5-vl" },
  { match: "llava" },
  { match: "internvl" },
  { match: "minicpm-v" },
  { match: "pixtral" },
];

/** True if the model id matches a known vision-capable name pattern.
 *  Empty/undefined/null and unknown ids return false. */
export function isVisionCapable(
  modelId: string | undefined | null
): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  for (const e of VISION_CAPABLE) {
    if (id.includes(e.match.toLowerCase())) return true;
  }
  return false;
}

export interface VisionFallbackResult {
  shouldSwap: boolean;
  /** The model id to actually use this turn (= currentModel when not swapping). */
  model: string;
}

/** Decide whether to route this turn to the provider's vision model.
 *  Swap iff: an image is present, a non-empty vision_model is configured, the
 *  current model differs from it, AND the current model is not already
 *  vision-capable. Idempotent: once swapped (current === visionModel) it stops
 *  swapping. */
export function resolveVisionFallback(args: {
  hasImage: boolean;
  currentModel: string;
  visionModel?: string;
}): VisionFallbackResult {
  const { hasImage, currentModel, visionModel } = args;
  const shouldSwap =
    hasImage &&
    !!visionModel &&
    visionModel.length > 0 &&
    currentModel !== visionModel &&
    !isVisionCapable(currentModel);
  return { shouldSwap, model: shouldSwap ? visionModel! : currentModel };
}
