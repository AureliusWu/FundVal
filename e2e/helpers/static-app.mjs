import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

// Isolated native-browser fixture: static GET/HEAD only; never the dev proxy.
export async function serveStaticApp(site) {
  const root = await realpath(site), activity = { writes: 0, swDenied: 0, closed: false };
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { activity.writes++; response.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (path === '/FundVal/sw.js') { activity.swDenied++; response.writeHead(503).end(); return; }
      if (!path.startsWith('/FundVal/') || /[\\\0]/.test(path)) throw new Error('outside');
      const full = await realpath(resolve(root, path.slice('/FundVal/'.length) || 'index.html')), child = relative(root, full);
      if (child.startsWith('..') || isAbsolute(child) || !(await stat(full)).isFile()) throw new Error('outside');
      const body = await readFile(full);
      response.writeHead(200, { 'Content-Type': mime[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${server.address().port}`, activity,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); activity.closed = true; } };
}
