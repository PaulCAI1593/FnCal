#!/usr/bin/env node
/**
 * Lifecycle helper tests (M3.2). Covers the Windows shutdown fallback without
 * needing OS pipes: armStdinShutdown is driven with a mock EventEmitter, since a
 * confined sandbox cannot spawn a child with piped stdio.
 *
 * Usage: node test/lifecycle.test.mjs
 */

import { EventEmitter } from 'node:events';
import { armStdinShutdown } from '../server.mjs';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function main() {
  {
    const stdin = new EventEmitter();
    const reasons = [];
    const cleanup = armStdinShutdown({ stdin, shutdown: (reason) => reasons.push(reason) });
    stdin.emit('end');
    record('stdin end -> shutdown(stdin-end)', 'stdin-end', reasons.join(','),
      reasons.length === 1 && reasons[0] === 'stdin-end');
    stdin.emit('close');
    record('stdin close -> shutdown(stdin-close)', 'stdin-end,stdin-close', reasons.join(','),
      reasons.join(',') === 'stdin-end,stdin-close');
    cleanup();
    stdin.emit('end');
    record('cleanup detaches listeners', '2 events only', String(reasons.length), reasons.length === 2);
  }

  {
    const stdin = new EventEmitter();
    let calls = 0;
    const cleanup = armStdinShutdown({ stdin, shutdown: () => { calls += 1; } });
    stdin.emit('close');
    record('close alone triggers one shutdown', '1', String(calls), calls === 1);
    cleanup();
  }

  {
    let threw = false;
    try {
      const cleanup = armStdinShutdown({ stdin: null, shutdown: () => {} });
      cleanup();
    } catch {
      threw = true;
    }
    record('missing stdin is tolerated', 'no throw', threw ? 'threw' : 'ok', !threw);
  }

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
