# ADR-0010: Native CSS tokens and Top Layer UI architecture

- **Status:** Accepted
- **Date:** 2026-11-19
- **Context:** `src/ui/` is moving from a stacked form layout to a mobile-first fiction player while retaining the current React, Vite, and Capacitor runtime.

## Decision

- Use `lucide-react` with static named imports for interface icons.
- Use modular native CSS and Hex/`rgba()` semantic Design Tokens. Keep `src/ui/styles.css` as the stylesheet barrel and define the `light`, `dark`, and `warm` token sets in `src/ui/styles/tokens.css`.
- Use native `<dialog>.showModal()` for modal overlays, the mobile library drawer, and companion sheets. Keep gesture handling small and limited to dedicated handles or horizontal drawer gestures.
- Keep the existing React and CSS toolchain. Do not add Tailwind CSS v4, Vaul, or a second icon library.
- Use CSS safe-area values and Capacitor 8 `SystemBars` with CSS inset injection. Store only presentation preferences such as desktop sidebar collapse in `localStorage`.

## Rationale

The application targets Android WebViews as well as desktop browsers. Native CSS tokens avoid raising the browser floor and keep styles inspectable. Static Lucide imports allow Vite to tree-shake unused icons. Native dialogs provide the browser Top Layer, backdrop, Escape handling, and focus behavior without a runtime dialog dependency. The CSS color forms remain compatible with the project's older WebView target.

## Consequences

- `npm run audit:ui` checks theme token parity, scattered color literals, unsupported color syntax, excessive `z-index`, and competing or hand-written icon sources.
- New UI styles should use semantic tokens; any exceptional literal needs a same-line or immediately preceding `ui-token-allow` comment with a reason.
- Dialog-specific behavior belongs in the small UI primitives under `src/ui/primitives/`.
- `GLOSSARY.md`, `src/harness/`, story storage, and native bridge plugins remain outside this presentation decision.

## Rejected options

- **Tailwind CSS v4:** its color features and browser baseline conflict with the WebView compatibility target and modular CSS migration.
- **Vaul:** it would make the sheet interaction depend on an additional gesture and scroll-lock runtime.
- **Portal-based dialog libraries:** native dialog elements already provide the required Top Layer behavior and remain in the React DOM tree.
