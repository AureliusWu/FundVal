import {
  BRIDGE_OPERATIONS,
  RemoteSchemaError,
  createBridgeRequest,
  validateBridgeResponse,
} from './remote-schema.js';

const BRIDGE_PAGE = './quote-bridge.html';
const DEFAULT_TIMEOUT_MS = 12_000;
const FRAME_LOAD_TIMEOUT_MS = 8_000;

export class QuoteBridgeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QuoteBridgeError';
    this.code = code || 'bridge_unavailable';
  }
}

function secureRequestId(cryptoObject) {
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    return 'bridge-' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new QuoteBridgeError('bridge_unavailable', 'Secure random request IDs are unavailable');
}

function requestTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 100 && number <= 30_000
    ? Math.trunc(number)
    : fallback;
}

function removeNode(node) {
  try { node?.remove(); } catch (error) {}
}

export class QuoteBridgeClient {
  constructor(options = {}) {
    this.window = options.window || globalThis.window;
    this.document = options.document || globalThis.document;
    this.crypto = options.crypto || globalThis.crypto;
    this.timeoutMs = requestTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.frame = null;
    this.framePromise = null;
    this.pending = new Map();
    this.listening = false;
    this.destroyed = false;
    this.queue = [];
    this.running = false;
    this.cancelFrameLoad = null;
    this.handleMessage = this.handleMessage.bind(this);
  }

  async ensureFrame() {
    if (this.destroyed) throw new QuoteBridgeError('bridge_unavailable', 'Quote bridge client was destroyed');
    if (this.frame?.contentWindow) return this.frame;
    if (this.framePromise) return this.framePromise;
    if (!this.window || !this.document?.createElement) {
      throw new QuoteBridgeError('bridge_unavailable', 'Quote bridge requires a browser document');
    }
    if (!this.listening) {
      this.window.addEventListener('message', this.handleMessage);
      this.listening = true;
    }

    this.framePromise = new Promise((resolve, reject) => {
      const frame = this.document.createElement('iframe');
      let settled = false;
      const timer = this.window.setTimeout(() => {
        finish(new QuoteBridgeError('bridge_unavailable', 'Quote bridge page timed out'));
      }, FRAME_LOAD_TIMEOUT_MS);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.window.clearTimeout(timer);
        frame.removeEventListener('load', onLoad);
        frame.removeEventListener('error', onError);
        this.cancelFrameLoad = null;
        if (error) {
          removeNode(frame);
          this.frame = null;
          this.framePromise = null;
          reject(error);
          return;
        }
        this.frame = frame;
        resolve(frame);
      };
      const onLoad = () => {
        if (!frame.contentWindow) {
          finish(new QuoteBridgeError('bridge_unavailable', 'Quote bridge window is unavailable'));
          return;
        }
        finish();
      };
      const onError = () => finish(new QuoteBridgeError('bridge_unavailable', 'Quote bridge page failed to load'));
      this.cancelFrameLoad = () => finish(new QuoteBridgeError('bridge_unavailable', 'Quote bridge load cancelled'));

      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('src', BRIDGE_PAGE);
      frame.addEventListener('load', onLoad);
      frame.addEventListener('error', onError);
      const parent = this.document.body || this.document.documentElement;
      if (!parent?.appendChild) {
        finish(new QuoteBridgeError('bridge_unavailable', 'Quote bridge mount point is unavailable'));
        return;
      }
      parent.appendChild(frame);
    });
    return this.framePromise;
  }

  handleMessage(event) {
    if (!this.frame?.contentWindow || event.source !== this.frame.contentWindow) return;
    const id = event.data && typeof event.data.requestId === 'string' ? event.data.requestId : '';
    const pending = this.pending.get(id);
    if (!pending) return;
    let response;
    try {
      response = validateBridgeResponse(event.data, {
        requestId: id,
        operation: pending.operation,
        params: pending.params,
      });
    } catch (error) {
      pending.reject(error instanceof RemoteSchemaError
        ? new QuoteBridgeError(error.code, error.message)
        : new QuoteBridgeError('invalid_response', 'Quote bridge response is invalid'));
      return;
    }
    if (!response.ok) {
      pending.reject(new QuoteBridgeError(response.errorCode, `Quote bridge failed: ${response.errorCode}`));
      return;
    }
    pending.resolve(response.data);
  }

  request(operation, params, options = {}) {
    if (this.destroyed || !this.window?.setTimeout || !this.document?.createElement || this.queue.length >= 100) {
      return Promise.reject(new QuoteBridgeError('bridge_unavailable', 'Quote bridge is unavailable or busy'));
    }
    // Keep waiting work in the parent, not the JSONP realm. The per-source
    // deadline begins only when dispatched. Queued cancellation never loads a
    // remote script. A bounded queue deadline prevents starvation indefinitely.
    return new Promise((resolve, reject) => {
      const job = { operation, params, options, resolve, reject, cancelled: false };
      const cancel = (code) => {
        job.cancelled = true;
        job.cleanup();
        this.queue = this.queue.filter(item => item !== job);
        reject(new QuoteBridgeError(code, 'Quote bridge queued request cancelled'));
      };
      const onAbort = () => cancel('aborted');
      const timer = this.window.setTimeout(() => cancel('timeout'), 60_000);
      job.cleanup = () => {
        this.window.clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { onAbort(); return; }
      this.queue.push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.running || this.destroyed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.destroyed) {
        const job = this.queue.shift();
        job.cleanup();
        if (job.cancelled) continue;
        try { job.resolve(await this.dispatch(job.operation, job.params, job.options)); }
        catch (error) { job.reject(error); }
      }
    } finally { this.running = false; }
  }

  resetFrame() {
    this.cancelFrameLoad?.();
    removeNode(this.frame);
    this.frame = null;
    this.framePromise = null;
  }

  async dispatch(operation, params, options = {}) {
    if (!BRIDGE_OPERATIONS.includes(operation)) {
      throw new QuoteBridgeError('unsupported_operation', 'Quote bridge operation is unsupported');
    }
    if (options.signal?.aborted) throw new QuoteBridgeError('aborted', 'Quote bridge request was aborted');
    const id = secureRequestId(this.crypto);
    let request;
    try {
      request = createBridgeRequest(operation, params, id);
    } catch (error) {
      if (error instanceof RemoteSchemaError) throw new QuoteBridgeError(error.code, error.message);
      throw error;
    }
    const cancelLoad = () => this.cancelFrameLoad?.();
    options.signal?.addEventListener('abort', cancelLoad, { once: true });
    let frame;
    try { frame = await this.ensureFrame(); }
    catch (error) {
      if (options.signal?.aborted) throw new QuoteBridgeError('aborted', 'Quote bridge request was aborted');
      throw error;
    } finally { options.signal?.removeEventListener('abort', cancelLoad); }
    if (this.destroyed) throw new QuoteBridgeError('bridge_unavailable', 'Quote bridge client was destroyed');
    if (options.signal?.aborted) throw new QuoteBridgeError('aborted', 'Quote bridge request was aborted');
    const timeoutMs = requestTimeout(options.timeoutMs, this.timeoutMs);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.window.clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Dropping the isolated document also stops its active JSONP task.
        // Merely removing the parent Promise leaves it blocking later jobs.
        if (callback === reject) this.resetFrame();
        callback(value);
      };
      const onAbort = () => finish(reject, new QuoteBridgeError('aborted', 'Quote bridge request was aborted'));
      const timer = this.window.setTimeout(() => {
        finish(reject, new QuoteBridgeError('timeout', 'Quote bridge request timed out'));
      }, timeoutMs);
      this.pending.set(id, {
        operation,
        params: request.params,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        // A sandbox without allow-same-origin has an opaque origin. Therefore
        // targetOrigin must be "*"; responses are authenticated by WindowProxy
        // identity plus requestId and strict operation-specific schemas.
        frame.contentWindow.postMessage(request, '*');
      } catch (error) {
        finish(reject, new QuoteBridgeError('bridge_unavailable', 'Quote bridge postMessage failed'));
      }
    });
  }

  officialFundData(fundCode, options) {
    return this.request('officialFundData', { fundCode }, options);
  }

  indexQuotes(codes, options) {
    return this.request('indexQuotes', { codes }, options);
  }

  securityQuotes(codes, options) {
    return this.request('securityQuotes', { codes }, options);
  }

  overseasComponents(codes, options) {
    return this.request('overseasComponents', { codes }, options);
  }

  destroy() {
    this.destroyed = true;
    for (const job of this.queue.splice(0)) {
      job.cleanup();
      job.reject(new QuoteBridgeError('bridge_unavailable', 'Quote bridge client was destroyed'));
    }
    for (const pending of this.pending.values()) {
      pending.reject(new QuoteBridgeError('bridge_unavailable', 'Quote bridge client was destroyed'));
    }
    this.pending.clear();
    if (this.listening) {
      this.window?.removeEventListener('message', this.handleMessage);
      this.listening = false;
    }
    this.resetFrame();
  }
}

export function createQuoteBridgeClient(options) {
  return new QuoteBridgeClient(options);
}
