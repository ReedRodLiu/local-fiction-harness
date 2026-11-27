# Contributing to Folio

Thanks for your interest in contributing.

## Development setup

1. Install Node.js 22+ and npm.
2. Install Android SDK / Gradle only if you plan to build the Android app.
3. Copy `.env.example` to `.env.local` and fill in test credentials locally (never commit real keys).
4. Install dependencies:

   ```bash
   npm install
   ```

## Common commands

```bash
npm run dev          # start Vite dev server
npm run typecheck    # TypeScript check (web)
npm run typecheck:harness
npm run build        # production web build
npm test             # unit/integration tests
npm run test:e2e     # end-to-end checks
npm run audit:ui     # UI token audit
npm run audit:version
```

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Run `npm run typecheck`, `npm run build`, and `npm test` before submitting.
- Update documentation and release notes when user-facing behavior changes.
- Do not commit secrets, signing keys, or personal corpora (see `.gitignore`).
