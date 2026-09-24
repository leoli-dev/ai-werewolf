import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only LLM proxy. Local inference servers (e.g. MTPLX) refuse browser
 * cross-origin requests, so the browser calls `/__llm/<path>` on the Vite
 * server with header `x-llm-base: http://127.0.0.1:8001/v1`, and the request
 * is forwarded server-side to `<base>/<path>`.
 */
function llmProxy(): Plugin {
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/__llm', async (req, res) => {
        const base = String(req.headers['x-llm-base'] ?? '').replace(/\/+$/, '');
        if (!/^https?:\/\//.test(base)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'missing or invalid x-llm-base header' } }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
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

export default defineConfig({
  plugins: [llmProxy()],
  server: { port: 5173 },
});
