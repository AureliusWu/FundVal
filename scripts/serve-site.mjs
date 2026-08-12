import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const port = 4173;
const types = {
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.tar': 'application/x-tar',
};

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`).pathname);
  const target = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (relative(root, target).startsWith('..')) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch (_) {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1');
