import type { LogLevel } from './config.js';

/**
 * Minimal structured logger: one JSON object per line on stdout/stderr (journald-friendly).
 * Never log secrets: passwords, session tokens, cookies, ICS feed URLs, passkey material.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Logger that adds `bindings` to every line, e.g. `logger.child({ feature: 'calendar' })`. */
  child(bindings: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialiseError(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return err;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Defaults to writing to process.stdout / process.stderr. */
  write?: (line: string, level: LogLevel) => void;
}

export function createLogger(options: LoggerOptions, bindings: LogFields = {}): Logger {
  const min = ORDER[options.level];
  const write =
    options.write ??
    ((line: string, level: LogLevel) => {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    });

  const log = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const entry: LogFields = { time: new Date().toISOString(), level, msg, ...bindings };
    if (fields) {
      for (const [k, v] of Object.entries(fields))
        entry[k] = k === 'err' || k === 'error' ? serialiseError(v) : v;
    }
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: entry.time, level, msg, note: 'unserialisable log fields' });
    }
    write(line, level);
  };

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (more) => createLogger(options, { ...bindings, ...more }),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = createLogger({ level: 'error', write: () => {} });
