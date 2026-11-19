import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { DISPLAY_BOOT_CONFIG } from './src/ui/displayBootConfig.ts';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function displayBootConfigPlugin(): Plugin {
  return {
    name: 'display-boot-config',
    transformIndexHtml(html) {
      return html.replace(
        '__LFH_DISPLAY_BOOT_CONFIG__',
        JSON.stringify(DISPLAY_BOOT_CONFIG).replace(/</g, '\\u003c'),
      );
    },
  };
}

function isLoopbackRequest(remoteAddress: string | undefined): boolean {
  return Boolean(remoteAddress && LOOPBACK_ADDRESSES.has(remoteAddress));
}

function isExposedHost(host: string | boolean | undefined): boolean {
  if (host === true) return true;
  if (typeof host !== 'string' || !host) return false;
  return host !== 'localhost' && !LOOPBACK_ADDRESSES.has(host);
}

function devTestConfigPlugin(options: {
  baseUrl: string;
  model: string;
  hasEnvKey: boolean;
}): Plugin {
  return {
    name: 'dev-test-config',
    apply: 'serve',
    configureServer(server) {
      if (options.hasEnvKey && isExposedHost(server.config.server.host)) {
        console.warn(
          '[dev-test-config] Detected non-loopback Vite host (--host). Forwarding x-use-dev-env-key remains restricted to loopback connections (127.0.0.1 / ::1).',
        );
      }
      server.middlewares.use('/__dev_test_config', (req, res) => {
        const isLoopback = isLoopbackRequest(req.socket?.remoteAddress);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            available: Boolean(options.baseUrl),
            proxyBaseUrl: '/__dev_llm_proxy',
            model: options.model,
            hasEnvKey: options.hasEnvKey && isLoopback,
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
      displayBootConfigPlugin(),
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
                    if (useDevKey && testApiKey && isLoopbackRequest(req.socket?.remoteAddress)) {
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
