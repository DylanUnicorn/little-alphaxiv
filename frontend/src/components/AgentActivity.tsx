import { memo, useEffect, useRef, useState } from "react";
import type { ActivityRenderItem, AgentActivityStep } from "../lib/agentActivity";

interface Props {
  activity: ActivityRenderItem;
  active: boolean;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isSearch(step: AgentActivityStep): boolean {
  return step.toolName === "web_search" || step.toolName.startsWith("search_");
}

function activeLabel(step: AgentActivityStep | undefined): string {
  if (!step) return "Agent is working";
  if (step.status !== "pending") return "Reviewing search results";
  if (isSearch(step)) {
    const source = step.label.replace(/ search$/i, "");
    return `Searching ${source}`;
  }
  return `Running ${step.label}`;
}

// Completed activity groups are historical content. Their props stay stable
// while the composer draft changes, so skip rebuilding their nested result
// lists on every keystroke.
export const AgentActivity = memo(function AgentActivity({ activity, active }: Props) {
  const [open, setOpen] = useState(active);
  const wasActive = useRef(active);

  useEffect(() => {
    if (active) setOpen(true);
    else if (wasActive.current) setOpen(false);
    wasActive.current = active;
  }, [active]);

  const lastStep = activity.steps[activity.steps.length - 1];
  const searchOnly = activity.steps.length > 0 && activity.steps.every(isSearch);
  const actionSummary = plural(
    activity.steps.length,
    searchOnly ? "search" : "action",
    searchOnly ? "searches" : "actions"
  );
  const hasKnownResultCount = activity.steps.some((step) => step.resultCount !== undefined);
  const resultSummary = hasKnownResultCount
    ? ` · ${plural(activity.totalResults, "result")}`
    : "";

  return (
    <details
      className={`agent-activity${active ? " is-active" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="agent-activity-summary"
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <span className="agent-activity-chevron" aria-hidden="true">›</span>
        <span className={`agent-activity-dot${active ? " is-running" : ""}`} aria-hidden="true" />
        <span className="agent-activity-title" aria-live={active ? "polite" : "off"}>
          {active ? activeLabel(lastStep) : "Agent activity"}
        </span>
        <span className="agent-activity-meta">{actionSummary}{resultSummary}</span>
      </summary>

      <ol className="agent-activity-steps">
        {activity.steps.map((step) => (
          <li className={`agent-activity-step is-${step.status}`} key={step.id}>
            <div className="agent-activity-step-heading">
              <span className="agent-activity-step-state" aria-hidden="true">
                {step.status === "success" ? "✓" : step.status === "error" ? "!" : "·"}
              </span>
              <span className="agent-activity-step-label">{step.label}</span>
              <span className="agent-activity-step-result">
                {step.status === "pending"
                  ? "Running"
                  : step.status === "error"
                    ? "Failed"
                    : step.resultCount === undefined
                      ? "Complete"
                      : plural(step.resultCount, "result")}
              </span>
            </div>
            {step.query && <div className="agent-activity-query">“{step.query}”</div>}
            {step.errorMessage && <div className="agent-activity-error">{step.errorMessage}</div>}
            {step.resultTitles.length > 0 && (
              <ul className="agent-activity-results">
                {step.resultTitles.map((title, index) => <li key={`${step.id}-${index}`}>{title}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
});
