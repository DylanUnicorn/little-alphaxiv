export interface QuickHistoryRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface QuickHistorySize {
  width: number;
  height: number;
}

interface QuickHistoryMetricsInput {
  anchor: QuickHistoryRect;
  tree: QuickHistorySize;
  viewport: QuickHistorySize;
}

export interface QuickHistoryPopoverMetrics extends QuickHistorySize {
  left: number;
  top: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function quickHistoryPopoverMetrics({
  anchor,
  tree,
  viewport,
}: QuickHistoryMetricsInput): QuickHistoryPopoverMetrics {
  const gutter = 8;
  const gap = 8;
  const width = clamp(
    tree.width + 16,
    92,
    Math.max(92, Math.min(320, viewport.width - gutter * 2)),
  );
  const top = clamp(
    anchor.bottom + gap,
    gutter,
    Math.max(gutter, viewport.height - 64 - gutter),
  );
  const height = clamp(
    tree.height + 16,
    64,
    Math.max(64, Math.min(300, viewport.height - top - gutter)),
  );
  const left = clamp(
    anchor.right - width,
    gutter,
    Math.max(gutter, viewport.width - width - gutter),
  );

  return { left, top, width, height };
}
