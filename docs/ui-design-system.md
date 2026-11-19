# UI design system

This guide is the implementation reference for `src/ui/`. The approved visual and interaction direction is mobile-first, local-first, and focused on reading and continuing a story. It follows [ADR-0010](adr/0010-native-css-tokens-and-top-layer-ui-architecture.md) and the accepted UI-06 specification, including its v1.1 corrections.

## Boundaries

- Keep story orchestration, model configuration semantics, diagnostics redaction, concurrency behavior, and storage formats in their existing owners. UI work must not change `src/harness/` or local story schemas unless a later ticket explicitly requires it.
- Presentation-only preferences may use `localStorage`; they must not duplicate story or model state.
- Preserve the main style import at `src/ui/styles.css`. Add rules to a focused module under `src/ui/styles/` and import that module from the barrel.
- Keep the official DeepSeek configuration in production. Do not expose custom endpoints, model names, or session-memory controls in the production settings UI.

## Tokens and type

- The only UI source of color literals is `src/ui/styles/tokens.css`. Use its semantic variables everywhere else. A deliberate exception must have a specific reason in a `/* ui-token-allow: reason */` comment on the same line or the line immediately above.
- The `light`, `dark`, and `warm` themes must define the same color-token keys. Use Hex or `rgba()` values; do not introduce `oklch()`, `oklab()`, `color-mix()`, or `light-dark()`.
- The default text size is `16px`; narrative line height is about `1.78`. Use the shared radius and font tokens. Keep ordinary primary actions monochrome; reserve the fiction accent for story structure and focus.
- Interactive targets should be at least `44×44px`. Prefer `100dvh` with a `100vh` fallback and apply safe-area insets to full-height and bottom-fixed regions.

## Components and overlays

- Import interface icons as static named imports from `lucide-react`; do not add other icon packs or hand-written inline SVG icons.
- Use the native-dialog primitives in `src/ui/primitives/`: `ModalDialog`, `SheetDialog`, `OverlayPageShell`, `InsetGroup`, and `BannerAlert`.
- Keep drag handling on a dedicated handle. Do not intercept vertical gestures in a dialog's scrolling content.
- Prefer semantic controls and labels. `data-testid` values represent stable E2E behavior; visual class names are free to change.

## E2E selectors

Slice 1 shell selectors include `app-topbar`, `library-drawer-trigger`, `desktop-library`, `story-list-item`, `story-menu-trigger`, `story-select-button`, `welcome-view`, `settings-page`, and `story-tree-sheet`. Preserve the established import, BYOK, diagnostic, turn, and story-tree `data-testid` contracts listed in issue #43 v1.1. When navigation changes, update the E2E path to use the visible control rather than reaching into presentation details.

## Slice dependencies

1. **UI-IMPL-01:** tokens, static audit, shell, library, welcome view, and basic settings.
2. **UI-IMPL-02** and **UI-IMPL-03:** each depend on UI-IMPL-01 and may proceed independently.
3. **UI-IMPL-04:** depends on UI-IMPL-01 and UI-IMPL-03.
4. **UI-IMPL-05:** depends on UI-IMPL-02, UI-IMPL-03, and UI-IMPL-04.

Each implementation slice should pass `npm run verify:all` before it is considered complete.

## Visual acceptance matrix

Before a release, inspect all six combinations below for clipping, horizontal overflow, contrast, and safe-area overlap:

| Theme | Mobile | Desktop |
| --- | --- | --- |
| Light | `390×844` | `1280×800` |
| Dark | `390×844` | `1280×800` |
| Warm | `390×844` | `1280×800` |
