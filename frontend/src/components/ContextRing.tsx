// Context-usage ring mounted in the ChatPanel model-selector row. A small SVG
// donut shows how full the conversation's context window is (used / usable);
// clicking it opens a popover with the full breakdown (used / total /
// reserved / usable) and the capacity + reserve controls.
//
// Capacity auto-resolves from the model (provider-reported context_length →
// curated table → 128K default) unless the user picks a preset. Reserve is the
// output budget held back for the reply. Both persist per-conversation. See
// lib/contextBudget.ts for the math and docs/superpowers/specs/2026-06-19-
// context-usage-ring-design.md for the design.

import { useEffect, useRef, useState } from "react";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { useContextBudget } from "../hooks/useContextBudget";
import {
  CAPACITY_PRESETS,
  formatTokens,
  type CapacitySource,
} from "../lib/contextBudget";

interface Props {
  conversationId: string;
  /** Effective system prompt (base + style modifier). In paper chats this
   *  carries the full PDF text — the dominant token consumer — so the ring
   *  counts it. Passed from ChatPanel, which already owns it. */
  systemPrompt: string;
}

const SOURCE_LABEL: Record<CapacitySource, string> = {
  override: "manual",
  detected: "detected",
  table: "curated",
  default: "default",
};

// Donut geometry. circumference = 2πr with r=8 → ~50.27.
const R = 8;
const CIRC = 2 * Math.PI * R;

function ringColor(status: "ok" | "warn" | "critical"): string {
  if (status === "warn") return "var(--ctx-warn, #f0a020)";
  if (status === "critical") return "var(--ctx-crit, #e05656)";
  return "var(--accent)";
}

export function ContextRing({ conversationId, systemPrompt }: Props) {
  const budget = useContextBudget({ conversationId, systemPrompt });
  const conv = useConversations((s) =>
    s.conversations.find((c) => c.id === conversationId)
  );
  const provider = useSettings((s) => s.getProvider(conv?.provider_id ?? null));
  const updateSettings = useConversations((s) => s.updateSettings);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close popover on outside click (same pattern as ChatToolbar's settings dropdown).
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (!budget || !conv) return null;

  const pct = Math.round(budget.pct * 100);
  const capacityValue = String(conv.context_capacity_override ?? 0);
  const reserveValue = conv.reserve_tokens ? String(conv.reserve_tokens) : "";
  const effectiveModel = conv.model || provider?.model || "";
  const isAuto = budget.source !== "override";

  return (
    <div className="ctx-ring-wrap" ref={ref}>
      <button
        className={`ctx-ring-btn ctx-ring-${budget.status}`}
        title={`Context usage: ${pct}%`}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Context usage ${pct} percent. Click for details.`}
      >
        <svg className="ctx-ring-svg" width="18" height="18" viewBox="0 0 20 20">
          <circle
            cx="10"
            cy="10"
            r={R}
            fill="none"
            className="ctx-ring-track"
            strokeWidth="3"
          />
          <circle
            cx="10"
            cy="10"
            r={R}
            fill="none"
            stroke={ringColor(budget.status)}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${budget.pct * CIRC} ${CIRC}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span className="ctx-ring-pct">{pct}%</span>
      </button>

      {open && (
        <div className="ctx-ring-popover">
          <div className="ctx-popover-title">Context usage</div>
          <div className="ctx-popover-bar">
            <div
              className={`ctx-popover-bar-fill ctx-ring-${budget.status}`}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
          <div className="ctx-popover-pct">{pct}% used</div>

          <dl className="ctx-popover-stats">
            <div>
              <dt>Used</dt>
              <dd>
                {formatTokens(budget.used)} <span className="muted">(estimated)</span>
              </dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{formatTokens(budget.total)}</dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd>
                {formatTokens(budget.reserve)}{" "}
                <span className="muted">(for reply)</span>
              </dd>
            </div>
            <div>
              <dt>Usable</dt>
              <dd>{formatTokens(budget.usable)}</dd>
            </div>
          </dl>

          <div className="ctx-popover-controls">
            <label className="ctx-control">
              <span className="ctx-control-label">Model capacity</span>
              <select
                className="ctx-control-select"
                value={capacityValue}
                onChange={(e) =>
                  updateSettings(conv.id, {
                    context_capacity_override: parseInt(e.target.value) || 0,
                  })
                }
              >
                {CAPACITY_PRESETS.map((p) => (
                  <option key={p.id} value={String(p.value)}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ctx-control">
              <span className="ctx-control-label">Reserved tokens</span>
              <input
                className="ctx-control-input"
                type="number"
                min={0}
                placeholder="auto"
                value={reserveValue}
                onChange={(e) =>
                  updateSettings(conv.id, {
                    reserve_tokens: parseInt(e.target.value) || 0,
                  })
                }
              />
            </label>
          </div>

          {isAuto && (
            <div className="ctx-popover-resolved">
              Resolved {formatTokens(budget.total)} · {SOURCE_LABEL[budget.source]}
              {effectiveModel ? ` · ${effectiveModel}` : ""}
            </div>
          )}
          {budget.dropped > 0 && (
            <div className="ctx-popover-truncated">
              ⚠ {budget.dropped} oldest message{budget.dropped > 1 ? "s" : ""} truncated on send
            </div>
          )}
        </div>
      )}
    </div>
  );
}
