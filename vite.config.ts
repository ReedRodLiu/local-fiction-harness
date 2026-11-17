import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function devTestConfigPlugin(options: {
  baseUrl: string;
  model: string;
  hasEnvKey: boolean;
}): Plugin {
  return {
    name: 'dev-test-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev_test_config', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            available: Boolean(options.baseUrl),
            proxyBaseUrl: '/__dev_llm_proxy',
            model: options.model,
            hasEnvKey: options.hasEnvKey,
          }),
        );
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const testBaseUrl = (env.VITE_TEST_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const testApiKey = (env.VITE_TEST_API_KEY ?? '').trim();
  const testModel = (env.VITE_TEST_MODEL ?? '').trim();

  let targetOrigin = '';
  let targetBasePath = '';
  if (testBaseUrl) {
    try {
      const parsed = new URL(testBaseUrl);
      targetOrigin = parsed.origin;
      targetBasePath = parsed.pathname.replace(/\/+$/, '');
    } catch {
      targetOrigin = '';
    }
  }

  return {
    envPrefix: 'APP_',
    plugins: [
      react(),
      ...(command === 'serve'
        ? [
            devTestConfigPlugin({
              baseUrl: targetOrigin ? testBaseUrl : '',
              model: testModel,
              hasEnvKey: Boolean(testApiKey),
            }),
          ]
        : []),
    ],
    server:
      command === 'serve' && targetOrigin
        ? {
            proxy: {
              '/__dev_llm_proxy': {
                target: targetOrigin,
                changeOrigin: true,
                rewrite: (path) => {
                  const suffix = path.replace(/^\/__dev_llm_proxy/, '');
                  return `${targetBasePath}${suffix}`;
                },
                configure: (proxy) => {
                  proxy.on('proxyReq', (proxyReq, req) => {
                    const useDevKey = req.headers['x-use-dev-env-key'] === '1';
                    proxyReq.removeHeader('x-use-dev-env-key');
                    if (useDevKey && testApiKey) {
                      proxyReq.setHeader('Authorization', `Bearer ${testApiKey}`);
                    }
                  });
                },
              },
            },
          }
        : undefined,
  };
});
