import fs from 'fs';
import path from 'path';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Logger V1.1 — Console + File with daily rotation
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3,
};

let MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'INFO';
let LOG_DIR: string = process.env.LOG_DIR || './logs';
let LOG_MAX_FILES = 14;
let currentLogDate = '';
let logStream: fs.WriteStream | null = null;
let tradeStream: fs.WriteStream | null = null;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function dateStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function ts(): string {
  return new Date().toISOString();
}

function rotateIfNeeded(): void {
  const today = dateStr();
  if (today === currentLogDate && logStream && tradeStream) return;

  ensureDir(LOG_DIR);
  currentLogDate = today;

  if (logStream) logStream.end();
  if (tradeStream) tradeStream.end();

  logStream = fs.createWriteStream(
    path.join(LOG_DIR, `bot-${today}.log`),
    { flags: 'a' },
  );
  tradeStream = fs.createWriteStream(
    path.join(LOG_DIR, `trades-${today}.log`),
    { flags: 'a' },
  );

  cleanOldLogs();
}

function cleanOldLogs(): void {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.match(/^(bot|trades)-\d{4}-\d{2}-\d{2}\.log$/))
      .sort()
      .reverse();

    for (let i = LOG_MAX_FILES * 2; i < files.length; i++) {
      fs.unlinkSync(path.join(LOG_DIR, files[i]));
    }
  } catch {
    // ignore cleanup errors
  }
}

function writeToFile(stream: fs.WriteStream | null, line: string): void {
  if (stream && !stream.destroyed) {
    stream.write(line + '\n');
  }
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function formatMeta(meta?: Record<string, any>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  return ' ' + JSON.stringify(meta);
}

function formatLine(level: LogLevel, meta: Record<string, any> | string, msg?: string): string {
  if (typeof meta === 'string') {
    return `${ts()} [${level.padEnd(5)}] ${meta}`;
  }
  return `${ts()} [${level.padEnd(5)}] ${msg ?? ''}${formatMeta(meta)}`;
}

export const logger = {
  configure(options: { level?: LogLevel; dir?: string; maxFiles?: number }) {
    if (options.level) MIN_LEVEL = options.level;
    if (options.dir) LOG_DIR = options.dir;
    if (options.maxFiles) LOG_MAX_FILES = options.maxFiles;
  },

  debug(meta: Record<string, any> | string, msg?: string) {
    if (!shouldLog('DEBUG')) return;
    const line = formatLine('DEBUG', meta, msg);
    console.log(line);
    rotateIfNeeded();
    writeToFile(logStream, line);
  },

  info(meta: Record<string, any> | string, msg?: string) {
    if (!shouldLog('INFO')) return;
    const line = formatLine('INFO', meta, msg);
    console.log(line);
    rotateIfNeeded();
    writeToFile(logStream, line);
  },

  warn(meta: Record<string, any> | string, msg?: string) {
    if (!shouldLog('WARN')) return;
    const line = formatLine('WARN', meta, msg);
    console.warn(line);
    rotateIfNeeded();
    writeToFile(logStream, line);
  },

  error(meta: any, msg?: string) {
    let line: string;
    if (meta instanceof Error) {
      line = `${ts()} [ERROR] ${msg ?? meta.message}\n${meta.stack}`;
    } else {
      line = formatLine('ERROR', meta, msg);
    }
    console.error(line);
    rotateIfNeeded();
    writeToFile(logStream, line);
  },

  /** Separate trade log — always written regardless of log level */
  trade(data: Record<string, any>) {
    const line = `${ts()} ${JSON.stringify(data)}`;
    rotateIfNeeded();
    writeToFile(tradeStream, line);
    if (shouldLog('INFO')) {
      console.log(`${ts()} [TRADE] ${JSON.stringify(data)}`);
    }
  },

  table(data: Record<string, any>[], title?: string) {
    if (title) console.log(`\n━━━ ${title} ━━━`);
    if (data.length > 0) {
      console.table(data);
    } else {
      console.log('  (vacío)');
    }
  },

  /** Flush and close streams */
  close() {
    if (logStream) { logStream.end(); logStream = null; }
    if (tradeStream) { tradeStream.end(); tradeStream = null; }
  },
};