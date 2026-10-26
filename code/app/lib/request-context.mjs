// Request-scoped context: which account is serving this request.
//
// The storage layer is per-user, while the DAV handler resolves the identity
// *after* routing starts (Basic auth / session cookie). A mutable store carried
// by AsyncLocalStorage bridges that without threading `userId` through every
// function: the server opens a context per request, the DAV handler fills in
// `userId` once authenticated, and store calls read it.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithContext(context, fn) {
  return storage.run(context, fn);
}

export function currentContext() {
  return storage.getStore() || null;
}
