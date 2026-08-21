# Sidebar Conversation Type Icons Design

## Problem

The history sidebar currently uses 11px emoji for general-chat and paper rows. In light themes the emoji are pale, platform-dependent, and visually too small beside 13px titles. Their silhouettes are also too similar at a glance, so users cannot reliably distinguish a conversation page from a paper-reading page while scanning history.

## Direction

Replace the emoji with two consistent, theme-aware line drawings:

- General chat: two overlapping square speech bubbles.
- Paper view: an open book with a visible center fold.

Each drawing sits in a 26px rounded-square visual anchor and uses an 18px SVG. The SVGs use rounded caps and joins so they feel friendly without becoming decorative. Inactive rows use the normal text color on the secondary surface, which preserves contrast across all themes. Hover uses the existing soft accent. The active row uses the theme accent as the icon background with `--accent-contrast` for the drawing.

The icon is decorative in the accessibility tree because the adjacent conversation title and row destination already provide the accessible meaning. The SVG remains dependency-free and inherits color from CSS, avoiding platform emoji differences and a new icon-library dependency.

## Scope and Verification

This change only affects expanded-sidebar history rows. It does not change grouping, navigation, deletion, counts, titles, or collapsed-sidebar controls. A focused component test will verify the two distinct SVG silhouettes, semantic classes, and decorative accessibility contract. Frontend typecheck, Vitest, production build, and a browser screenshot in the Alphaxiv theme will verify behavior and appearance.
