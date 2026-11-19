# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `ReedRodLiu/local-fiction-harness` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### UI implementation

`src/ui/` follows `docs/ui-design-system.md` and ADR-0010. Keep UI colors in `src/ui/styles/tokens.css`, use static named `lucide-react` imports, and run `npm run audit:ui` after UI changes. Preserve semantic `data-testid` contracts when adjusting E2E flows. The UI implementation order and dependencies are documented in the design system guide.
