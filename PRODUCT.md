# Product

## Register

product

## Users

Researchers, students, and self-hosters who read arXiv papers regularly. They
open the app to discover papers through conversation with an LLM, then read a
chosen PDF side-by-side with a paper-aware assistant that can annotate, take
notes, and sync to Zotero. They are technical — bring-your-own
OpenAI-compatible API key, self-host the backend — and they value privacy
(server-side storage, keys encrypted at rest, per-user accounts). They want a
calm reading environment, not a noisy SaaS dashboard.

## Product Purpose

A self-hosted, alphaxiv-style arXiv paper-reading app. Chat with an LLM to
discover papers (general chat); click a result and the PDF opens with a
paper-aware assistant (paper view). Bring-your-own-key. User data — chat
history, PDF annotations, provider config, settings — lives in a server-side
SQLite database scoped per-user via httpOnly session-cookie auth. Success is a
focused, fast, private reading-and-discussion workspace that disappears into
the task.

## Brand Personality

Calm, academic, restrained, developer-tool-credible. A reading lamp, not a
billboard. Trust through understated competence, not decoration. The brand mark
is the Greek letter α (alpha) set in a single-accent (indigo) gradient rounded
square — used small in the sidebar and as the login lockup. System sans for UI,
mono for code and arXiv ids. Closer to Linear / Notion / a well-made terminal
than to a marketing site.

## Anti-references

- SaaS landing-page aesthetics on app surfaces: gradient text, hero-metric
  blocks, glassmorphism, oversized display type.
- Over-decorated form controls, custom scrollbars, gratuitous motion.
- Warm cream / sand / paper backgrounds — this is a dark-first reading tool,
  not an editorial magazine.
- "Fun" branding that competes with the paper being read.

## Design Principles

- **The paper is the hero.** UI chrome recedes; the PDF and the conversation
  own the surface. Restraint is the default; commit color only where it earns
  focus — primary action, current selection, state.
- **Consistency over surprise.** One button shape, one form-control vocabulary,
  one accent, one type ramp across every screen, login included. Earned
  familiarity, not invented affordances.
- **Dark-first, theme-aware.** Default dark; every surface must hold up across
  all 11 themes via tokens, never hardcoded colors.
- **Calm motion.** Transitions convey state (focus, hover, loading), nothing
  else. No page-load choreography; users are here to read, not to watch.
- **Privacy is visible.** Trust cues (encrypted at rest, per-user, server-side)
  appear where relevant, in plain language — not as security theater.

## Accessibility & Inclusion

- WCAG AA contrast on all text (≥4.5:1 body, ≥3:1 large) across every theme.
- Visible `:focus-visible` rings on all interactive elements; keyboard-reachable
  forms with associated labels.
- `prefers-reduced-motion` honored (motion is minimal to begin with).
- The theme system (incl. light, sepia, solarized-light) serves varied
  ambient-light and reading-preference needs.
