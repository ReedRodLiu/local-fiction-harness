# Troubleshooting

## Environment

- Use Node.js 22 or newer.
- Run `npm ci` before development or builds.
- Android builds require Android SDK, JDK 17, and the bundled Gradle Wrapper.

## Common setup issues

### `npm ci` fails

- Delete `node_modules/` and retry.
- Confirm the Node version with `node --version`.

### Type check or build fails

- Run `npm run audit:version` first; version mismatches between `package.json` and `android/app/build.gradle` will fail CI.
- Run `npm run typecheck:harness` and `npm run typecheck` separately to isolate the failing project.

### Android build fails

- Ensure Android SDK and JDK 17 are installed.
- Run `npm run android:sync` before Gradle tasks.
- For release builds, signing keys are intentionally not committed. Configure your own keystore or use the project's documented local signing setup.

### Model requests fail

- Verify the API key, base URL, and model name in app settings.
- Check provider-side billing, rate limits, and network access.
- Folio sends requests directly from the client; there is no Folio-operated proxy.

### Release/APK issues

- Use the signed APK from GitHub Releases for end-user installation.
- Do not commit `.env.local`, signing keys, or generated build artifacts.
