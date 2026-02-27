/**
 * Logger utility for the MCP Router.
 * Writes structured logs to stderr to keep stdout clean for MCP protocol.
 * Also writes to a log file for debugging when stderr is captured by a parent process.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

let currentLevel: LogLevel = 'info';
let logFilePath: string | null = null;

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

/**
 * Enable file logging. The log file is created next to the router's entry script.
 */
export function enableFileLogging(): void {
    try {
        // Write log file next to the dist/index.js (i.e., in the dist/ directory)
        const scriptDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
        const logsDir = join(scriptDir, '..', 'logs');
        mkdirSync(logsDir, { recursive: true });
        logFilePath = join(logsDir, 'mcp-router.log');
        // Write a startup marker
        appendFileSync(logFilePath, `\n${'='.repeat(80)}\n`);
        appendFileSync(logFilePath, `Router started at ${new Date().toISOString()}\n`);
        appendFileSync(logFilePath, `${'='.repeat(80)}\n`);
    } catch {
        // Silently fail if we can't write logs
        logFilePath = null;
    }
}

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, message: string, context?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [mcp-router]`;
    if (context && Object.keys(context).length > 0) {
        return `${prefix} ${message} ${JSON.stringify(context)}`;
    }
    return `${prefix} ${message}`;
}

function writeLog(formatted: string): void {
    process.stderr.write(formatted + '\n');
    if (logFilePath) {
        try {
            appendFileSync(logFilePath, formatted + '\n');
        } catch {
            // Ignore file write errors
        }
    }
}

export const logger = {
    debug(message: string, context?: Record<string, unknown>): void {
        if (shouldLog('debug')) {
            writeLog(formatMessage('debug', message, context));
        }
    },

    info(message: string, context?: Record<string, unknown>): void {
        if (shouldLog('info')) {
            writeLog(formatMessage('info', message, context));
        }
    },

    warn(message: string, context?: Record<string, unknown>): void {
        if (shouldLog('warn')) {
            writeLog(formatMessage('warn', message, context));
        }
    },

    error(message: string, context?: Record<string, unknown>): void {
        if (shouldLog('error')) {
            writeLog(formatMessage('error', message, context));
        }
    },
};
