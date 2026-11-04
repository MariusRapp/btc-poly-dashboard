// Runs the Worker locally with Node (no Cloudflare account needed):
//   node kalshi-proxy/dev.mjs            → http://localhost:8787
// then open the dashboard with ?kalshi=http://localhost:8787
import http from 'node:http';
import worker from './worker.js';

const PORT = +(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  try {
    const headers = req.headers.origin ? { Origin: req.headers.origin } : {};
    const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
}).listen(PORT, () => console.log(`Kalshi proxy on http://localhost:${PORT}`));
