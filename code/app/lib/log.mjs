// JSON Lines logger (built-ins only). One record per line, ISO timestamp first.
// File append failures are swallowed: logging must never take the app down.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createLogger({ file, alsoStdout = true }) {
  const directory = path.dirname(file);
  let ready = fs.mkdir(directory, { recursive: true }).catch(() => {});

  function write(record) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    if (alsoStdout) process.stdout.write(`${line}\n`);
    ready = ready
      .then(() => fs.appendFile(file, `${line}\n`, 'utf8'))
      .catch(() => {});
    return line;
  }

  return {
    file,
    write,
    /** Access records: one line per HTTP request. */
    access: (entry) => write({ type: 'access', ...entry }),
    /** Lifecycle records: start/stop/config problems. */
    event: (event, detail = {}) => write({ type: 'event', event, ...detail }),
  };
}
