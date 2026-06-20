// Speech-bubble tooltip that replaces native `title=` hover boxes app-wide.
//
// Why not just `title`:
//   • Native tooltips wait ~500ms+ before appearing and render as a plain
//     system rectangle. This opens the instant the cursor enters the trigger
//     and renders a rounded speech bubble with a tail pointing at it.
//   • Native tooltips are clipped by any `overflow: auto` ancestor (the
//     conversation list, history list, chat-message scroller). The bubble is
//     `position: fixed` and placed in viewport pixels, so it is never clipped
//     and always sits above the chrome.
//
// Behaviour:
//   • Opens on mouseenter AND on keyboard focus (not just hover).
//   • Auto-flips to the opposite side if the preferred side would push the
//     bubble off-screen, then falls back to whichever side has the most room.
//   • Disabled triggers show no tooltip (matches native `title` on disabled
//     buttons) unless `showWhenDisabled` is set.
//   • Gives the trigger an accessible name via `aria-label` — but only if the
//     trigger doesn't already have one, so richer labels (e.g. the context
//     ring's "Context usage 42 percent. Click for details.") are preserved.
//   • Hides on scroll/resize so the bubble never detaches from a moving
//     trigger.
//
// The single child is cloned so the tooltip can wire its hover/focus handlers
// and supply an accessible name; any handlers the child already has are called
// first (preserved, not clobbered). The child must be a single element
// (button / link / span).

import {
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

interface Props {
  label: string;
  /** Preferred side of the trigger on which to place the bubble. Auto-flips
   *  on viewport overflow. Defaults to "top". */
  side?: TooltipSide;
  /** Set when the trigger is a block-level element that must fill its
   *  container (e.g. the full-width arXiv preview card) so the host wrapper
   *  doesn't shrink it to inline size. */
  block?: boolean;
  /** Render the bubble even when the trigger is disabled. Default false. */
  showWhenDisabled?: boolean;
  children: ReactElement;
}

const GAP = 8; // px between the trigger edge and the bubble
const VIEWPAD = 6; // px kept inside the viewport edge

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

export function Tooltip({ label, side = "top", block, showWhenDisabled, children }: Props) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [sideEff, setSideEff] = useState<TooltipSide>(side);
  const [pos, setPos] = useState<CSSProperties>({});

  // The child's own props — read once per render so we can preserve its
  // existing handlers and accessible name instead of overwriting them.
  const childProps = (isValidElement(children) ? children.props : {}) as Record<string, unknown>;
  const disabled = childProps.disabled === true;
  const active = open && !(disabled && !showWhenDisabled);

  // Measure + place the bubble whenever it opens (or its label/side changes
  // while open). Runs as a layout effect so the position is settled before
  // the browser paints — no flash at the fallback (0,0) corner.
  useLayoutEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    const bubble = bubbleRef.current;
    if (!host || !bubble) return;

    const hr = host.getBoundingClientRect();
    const br = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Room to spare on each side (how far the bubble's far edge lands inside
    // the viewport, minus the gap and padding). >0 means it fits.
    const room: Record<TooltipSide, number> = {
      top: hr.top - br.height - GAP - VIEWPAD,
      bottom: vh - hr.bottom - br.height - GAP - VIEWPAD,
      left: hr.left - br.width - GAP - VIEWPAD,
      right: vw - hr.right - br.width - GAP - VIEWPAD,
    };

    let chosen: TooltipSide = side;
    if (room[side] < 0) {
      const opp = OPPOSITE[side];
      chosen =
        room[opp] >= 0
          ? opp
          : ((Object.keys(room) as TooltipSide[]).reduce((a, b) =>
              room[a] >= room[b] ? a : b
            ) as TooltipSide);
    }
    setSideEff(chosen);

    // Viewport-pixel coordinates for the chosen side, centered on the trigger
    // and clamped so the bubble never leaves the viewport.
    const cx = hr.left + hr.width / 2;
    const cy = hr.top + hr.height / 2;
    let top: number;
    let left: number;
    if (chosen === "top") {
      top = hr.top - br.height - GAP;
      left = clamp(cx - br.width / 2, br.width, vw);
    } else if (chosen === "bottom") {
      top = hr.bottom + GAP;
      left = clamp(cx - br.width / 2, br.width, vw);
    } else if (chosen === "left") {
      left = hr.left - br.width - GAP;
      top = clamp(cy - br.height / 2, br.height, vh);
    } else {
      left = hr.right + GAP;
      top = clamp(cy - br.height / 2, br.height, vh);
    }
    setPos({ top, left });
  }, [active, side, label]);

  // Hide on any scroll (capture, so inner scrollers count) or viewport resize,
  // so the bubble can't drift away from a trigger that moves underneath it.
  useLayoutEffect(() => {
    if (!active) return;
    const hide = () => setOpen(false);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [active]);

  const show = () => {
    if (disabled && !showWhenDisabled) return;
    setOpen(true);
  };
  const hide = () => setOpen(false);

  const trigger = isValidElement(children)
    ? cloneElement(children, {
        ...(childProps["aria-label"] == null ? { "aria-label": label } : {}),
        onMouseEnter: (e: React.MouseEvent) => {
          (childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
          show();
        },
        onMouseLeave: (e: React.MouseEvent) => {
          (childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
          hide();
        },
        onFocus: (e: React.FocusEvent) => {
          (childProps.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
          show();
        },
        onBlur: (e: React.FocusEvent) => {
          (childProps.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
          hide();
        },
      } as Record<string, unknown>)
    : children;

  return (
    <span
      className={"tooltip-host" + (block ? " block" : "")}
      ref={hostRef}
      data-disabled={disabled ? "true" : "false"}
    >
      {trigger}
      <span
        className="tooltip-bubble"
        ref={bubbleRef}
        role="tooltip"
        data-side={sideEff}
        data-show={active ? "true" : "false"}
        style={pos}
      >
        {label}
      </span>
    </span>
  );
}

/** Center a box of `size` at `start`, clamped so it stays inside the viewport
 *  with VIEWPAD to spare. If the box is wider than the viewport, center it. */
function clamp(start: number, size: number, max: number): number {
  const lo = VIEWPAD;
  const hi = max - size - VIEWPAD;
  if (hi < lo) return Math.max(0, (max - size) / 2);
  return Math.min(hi, Math.max(lo, start));
}
