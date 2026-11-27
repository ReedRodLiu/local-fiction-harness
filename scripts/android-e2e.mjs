import { pathToFileURL } from 'node:url';
import { runSuiteCli } from './android-test-runner/index.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSuiteCli('e2e', process.argv.slice(2)).catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
