import { copyFileSync, existsSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { browserEnv, envServerKeys, normalizeBaseUrl } from './src/config';

/**
 * Dev-only LLM proxy. Local inference servers (e.g. MTPLX) refuse browser
 * cross-origin requests, so the browser calls `/__llm/<path>` on the Vite
 * server and the request is forwarded server-side to `<LLM_BASE_URL>/<path>`
 * (or to the `x-llm-base` header: the server picked in 配置, which may be any
 * host on the LAN). A key sent by the browser (from its encrypted vault) is
 * passed through; otherwise the `.env` key of that server (`LLM_API_KEY`,
 * `LLM_API_KEY_2`, …) is added — only for its own address, so a key never
 * reaches the browser or any other host.
 */
function llmProxy(env: Record<string, string>): Plugin {
  const keys = envServerKeys(env);
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/__llm', async (req, res) => {
        const base = normalizeBaseUrl(String(req.headers['x-llm-base'] ?? env.LLM_BASE_URL ?? ''));
        if (!/^https?:\/\//.test(base)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'LLM_BASE_URL 未配置（见 .env）' } }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const envKey = keys.get(base);
        if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
        else if (envKey) headers.authorization = `Bearer ${envKey}`;
        try {
          const upstream = await fetch(base + (req.url ?? ''), {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          });
          res.statusCode = upstream.status;
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: { message: `proxy upstream error: ${(e as Error).message}` } }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // first run: seed .env from the committed template
  if (!existsSync('.env') && existsSync('.env.example')) copyFileSync('.env.example', '.env');
  const env = loadEnv(mode, process.cwd(), 'LLM_');
  return {
    plugins: [llmProxy(env)],
    // non-secret settings for the browser (every server); the API keys stay on the server
    define: { __LLM_ENV__: JSON.stringify(browserEnv(env)) },
    // relative asset paths: the build works under any sub-path (GitHub Pages: /<repo>/)
    base: './',
    server: { port: 5173 },
  };
});
