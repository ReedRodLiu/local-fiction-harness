import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.localfiction.harness',
  appName: 'Folio',
  webDir: 'dist',
  plugins: {
    // Explicitly keep CapacitorHttp disabled so LLM requests never buffer full responses.
    CapacitorHttp: {
      enabled: false,
    },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
