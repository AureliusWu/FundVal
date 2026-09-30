import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyFundData } from './dev-data-proxy.mjs';

const root = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const port = Number(process.env.FUNDVAL_E2E_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FundVal server port.');
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
  let requestUrl, pathname;
  try {
    requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch (_) {
    response.writeHead(400).end();
    return;
  }
  if (requestUrl.pathname.startsWith('/__fundval_dev/')) {
    await proxyFundData(request, response, requestUrl);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
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
