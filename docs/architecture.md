# Architecture Overview

Folio is a **client-only** application. It does not run a self-hosted model gateway or business backend. The client stores data locally and sends model requests directly to the provider chosen by the user.

## High-level components

- `src/ui/`: React application, screens, components, styles, and interaction logic.
- `src/harness/`: core domain and runtime logic, including context management, prompt packs, proposal protocol, refusal handling, import/export, backups, provider presets, key configuration, diagnostics, and SSE streaming.
- `src/platform/`: platform seam between web runtime and Capacitor/Android native bridges (chunked SSE, HTTP text, secure storage, updater, binary downloader).
- `android/`: Capacitor Android project, Gradle build variants, native plugins, and release configuration.
- `docs/adr/`: architecture decision records.

## Runtime model

1. The user configures a model provider and API key in the client.
2. Folio builds prompts locally and sends requests directly to the selected provider.
3. Stories, branches, character data, and conversation history are stored on the device.
4. Optional native capabilities on Android are accessed through the platform seam rather than web-only APIs.

## Data and privacy boundaries

- API keys are not included in `.folio.json` backups.
- Runtime diagnostics are designed to avoid storing full user content.
- Personal corpora and local chat exports are intentionally kept out of version control.

## Testing and verification

- Unit/integration: `npm test` (Vitest)
- Type checks: `npm run typecheck`, `npm run typecheck:harness`
- Web build: `npm run build`
- E2E: `npm run test:e2e` and related scripts
- Android: `npm run android:build`, `npm run android:build:release`
- Audits: `npm run audit:ui`, `npm run audit:version`, `npm run audit:artifacts`
