/**
 * DownstreamManager — lazily spawns and manages child MCP server processes.
 *
 * Design:
 * - One child process per unique [args + final resolved env] combination
 * - Child processes are created ON DEMAND when the first tool call targeting that entry arrives
 * - A "probe" downstream is created eagerly for the first entry to discover tool schemas
 * - Env priority: --env (lowest) → mcp-router process.env (middle) → --router ENV_KEY (highest)
 * - A "default" downstream (no inject, no extra env) is created lazily for tools with no matching entry
 */

/** Sentinel entry representing a default downstream with only passthroughArgs — no inject, no extra env. */
const DEFAULT_ENTRY: RouterEntry = {
    toolPattern: '',
    injectParam: '',
    injectValue: '',
    envOverrides: {},
};

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ChildProcess } from 'node:child_process';
import type {
    RouterEntry,
    ConnectionStatus,
    RouterConfig,
    ToolCallResult,
    ToolDefinition,
} from './types.js';
import { computeDownstreamKey } from './router-parser.js';
import { logger } from './logger.js';

/**
 * Internal state for a downstream connection, including the MCP client and child process.
 */
interface DownstreamState {
    entry: RouterEntry;
    key: string;
    client: Client | null;
    transport: StdioClientTransport | null;
    process: ChildProcess | null;
    status: ConnectionStatus;
    lastHeartbeat: string | null;
    consecutiveFailures: number;
    tools: ToolDefinition[];
    reconnecting: boolean;
    /** Timestamp of the last tool call routed to this downstream. */
    lastToolCall: number;
}

export class DownstreamManager {
    private readonly _downstreams = new Map<string, DownstreamState>();
    private readonly _config: RouterConfig;
    private _idleTimer: ReturnType<typeof setInterval> | null = null;

    /** Idle timeout in ms — downstreams with no tool call for this duration are cleaned up. */
    private static readonly IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
    /** How often to check for idle downstreams. */
    private static readonly IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

    constructor(config: RouterConfig) {
        this._config = config;
        this._startIdleSweep();
    }

    /**
     * Resolve the final values of explicitly-specified env keys.
     * Only keys from globalEnv (--env) and entryEnvOverrides (--router) are included.
     * Priority: --env (lowest) → process.env (middle) → --router ENV_KEY (highest).
     * Used for downstream keying (same resolved env = same child process).
     */
    private _resolveExplicitEnv(entryEnvOverrides: Record<string, string>): Record<string, string> {
        const result: Record<string, string> = {};
        const allKeys = new Set([
            ...Object.keys(this._config.globalEnv),
            ...Object.keys(entryEnvOverrides),
        ]);

        for (const key of allKeys) {
            // --env (lowest priority)
            if (key in this._config.globalEnv) {
                result[key] = this._config.globalEnv[key]!;
            }
            // process.env (middle priority)
            const processVal = process.env[key];
            if (processVal !== undefined) {
                result[key] = processVal;
            }
            // --router ENV (highest priority)
            if (key in entryEnvOverrides) {
                result[key] = entryEnvOverrides[key]!;
            }
        }

        return result;
    }

    /**
     * Start a periodic timer that cleans up idle downstream processes.
     */
    private _startIdleSweep(): void {
        this._idleTimer = setInterval(() => {
            void this._sweepIdleDownstreams();
        }, DownstreamManager.IDLE_CHECK_INTERVAL_MS);
        // Don't let this timer keep the process alive.
        this._idleTimer.unref();
    }

    /**
     * Check all downstreams and clean up any that have been idle too long.
     */
    private async _sweepIdleDownstreams(): Promise<void> {
        const now = Date.now();
        for (const state of this._downstreams.values()) {
            if (
                state.status === 'Connected' &&
                state.client &&
                now - state.lastToolCall >= DownstreamManager.IDLE_TIMEOUT_MS
            ) {
                logger.info('Cleaning up idle downstream', {
                    key: state.key,
                    injectValue: state.entry.injectValue || '(default)',
                    idleMs: now - state.lastToolCall,
                });
                try {
                    await this._cleanupDownstream(state);
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    logger.warn('Failed to clean up idle downstream', { key: state.key, error: msg });
                }
                // Re-check: if a tool call arrived during the async cleanup,
                // don't mark as Disconnected — callTool will handle reconnection.
                if (Date.now() - state.lastToolCall >= DownstreamManager.IDLE_TIMEOUT_MS) {
                    state.status = 'Disconnected';
                }
            }
        }
    }

    /**
     * Eagerly create the downstream for the first RouterEntry to probe tool schemas.
     * Returns the discovered tool definitions. Call this once at startup.
     */
    async probeToolSchemas(): Promise<ToolDefinition[]> {
        // Use first configured entry for probe; fall back to the default (no-inject) downstream
        const probeEntry = this._config.entries[0] ?? DEFAULT_ENTRY;
        if (this._config.entries.length === 0) {
            logger.info('No router entries configured — probing default downstream for tool schemas');
        }

        const state = await this.getOrCreateDownstream(probeEntry);

        if (state.status !== 'Connected') {
            logger.warn('Probe downstream failed to connect', {
                injectValue: probeEntry.injectValue || '(default)',
            });
            return [];
        }

        return state.tools;
    }

    /**
     * Get or lazily create the downstream for a given RouterEntry.
     * Returns the state even if connection failed (check state.status).
     */
    async getOrCreateDownstream(entry: RouterEntry): Promise<DownstreamState> {
        const resolvedEnv = this._resolveExplicitEnv(entry.envOverrides);
        const key = computeDownstreamKey(this._config.passthroughArgs, resolvedEnv);

        const existing = this._downstreams.get(key);
        if (existing) {
            return existing;
        }

        const state: DownstreamState = {
            entry,
            key,
            client: null,
            transport: null,
            process: null,
            status: 'Connecting',
            lastHeartbeat: null,
            consecutiveFailures: 0,
            tools: [],
            reconnecting: false,
            lastToolCall: Date.now(),
        };
        this._downstreams.set(key, state);

        try {
            await this._connectDownstream(state);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to create downstream', {
                key,
                injectValue: entry.injectValue,
                error: msg,
            });
            state.status = 'Failed';
        }

        return state;
    }

    /**
     * Spawn a child process and connect to it.
     * Env priority: --env (lowest) → mcp-router process.env (middle) → --router ENV_KEY (highest).
     */
    private async _connectDownstream(state: DownstreamState): Promise<void> {
        const { entry, key } = state;
        logger.info('Connecting to downstream MCP', {
            key,
            injectValue: entry.injectValue,
            toolPattern: entry.toolPattern,
        });

        // passthroughArgs[0] is the command, the rest are arguments
        // e.g. ["npx", "-y", "@azure/mcp@latest", "server", "start", "--namespace", "kusto"]
        const [command, ...childArgs] = this._config.passthroughArgs;
        if (!command) {
            throw new Error('No command specified in --args. At least one --args token is required.');
        }

        // Build environment for the child process.
        // Priority: --env (lowest) → process.env (middle) → --router ENV_KEY (highest)
        const env: Record<string, string> = {
            ...this._config.globalEnv,
            ...(process.env as Record<string, string>),
            ...entry.envOverrides,
        };

        // Ensure AZURE_TOKEN_CREDENTIALS has a default
        if (!env['AZURE_TOKEN_CREDENTIALS']) {
            env['AZURE_TOKEN_CREDENTIALS'] = 'managedidentitycredential';
        }

        logger.info('Final resolved env for downstream', {
            key,
            AZURE_TOKEN_CREDENTIALS: env['AZURE_TOKEN_CREDENTIALS'] ?? '(not set)',
            AZURE_CLIENT_ID: env['AZURE_CLIENT_ID'] ?? '(not set)',
            IDENTITY_ENDPOINT: env['IDENTITY_ENDPOINT'] ?? '(not set)',
            IDENTITY_HEADER: env['IDENTITY_HEADER'] ? '(set)' : '(not set)',
        });

        logger.info('Spawning downstream MCP process', {
            key,
            command,
            args: childArgs,
        });

        const transport = new StdioClientTransport({
            command,
            args: childArgs,
            env,
        });

        const client = new Client(
            {
                name: `mcp-router-downstream-${key}`,
                version: '1.0.0',
            },
            { capabilities: {} }
        );

        await client.connect(transport);

        const toolsResult = await client.listTools();
        const tools: ToolDefinition[] = (toolsResult.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as ToolDefinition['inputSchema'],
        }));

        state.client = client;
        state.transport = transport;
        state.process = (transport as unknown as { _process?: ChildProcess })._process ?? null;
        state.status = 'Connected';
        state.lastHeartbeat = new Date().toISOString();
        state.consecutiveFailures = 0;
        state.tools = tools;

        logger.info('Connected to downstream MCP', {
            key,
            injectValue: entry.injectValue,
            toolCount: tools.length,
        });

        // Monitor child process exit for immediate reconnection notification
        if (state.process) {
            state.process.on('exit', (code, signal) => {
                logger.warn('Downstream process exited unexpectedly', { key, code, signal });
                state.status = 'Disconnected';
                state.client = null;
                state.transport = null;
                state.process = null;
            });
        }
    }

    /**
     * Reconnect a failed/disconnected downstream by key.
     */
    private async reconnect(key: string): Promise<boolean> {
        const state = this._downstreams.get(key);
        if (!state) {
            logger.error('Cannot reconnect: unknown downstream', { key });
            return false;
        }

        if (state.reconnecting) {
            logger.debug('Already reconnecting', { key });
            return false;
        }

        state.reconnecting = true;
        try {
            await this._cleanupDownstream(state);
            await this._connectDownstream(state);
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Reconnection failed', { key, error: msg });
            state.status = 'Failed';
            return false;
        } finally {
            state.reconnecting = false;
        }
    }

    /**
     * Clean up a downstream connection (kill process, close client).
     * @param force - If true, skip SIGTERM and go straight to SIGKILL (used during forced shutdown).
     */
    private async _cleanupDownstream(state: DownstreamState, force = false): Promise<void> {
        try {
            if (state.client) {
                await state.client.close();
            }
        } catch {
            // Ignore close errors
        }

        if (state.process && !state.process.killed) {
            if (force) {
                // Forced shutdown — SIGKILL immediately, no waiting.
                state.process.kill('SIGKILL');
            } else {
                // Graceful: SIGTERM first, escalate to SIGKILL after 1s.
                // Keep this short — the parent (Session.Proxy) may SIGKILL
                // the entire process tree at any moment.
                state.process.kill('SIGTERM');

                await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                        if (state.process && !state.process.killed) {
                            state.process.kill('SIGKILL');
                        }
                        resolve();
                    }, 1000);

                    if (state.process) {
                        state.process.once('exit', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    } else {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            }
        }

        state.client = null;
        state.transport = null;
        state.process = null;
    }

    /**
     * Call a tool on a specific downstream (looked up by hash key).
     * Lazily creates the downstream if not yet instantiated.
     */
    async callTool(
        entry: RouterEntry,
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        let state = await this.getOrCreateDownstream(entry);
        const key = state.key;
        state.lastToolCall = Date.now();
        logger.info('callTool', { key, toolName, argKeys: Object.keys(args) });
        // If the downstream went away (process crashed), attempt one inline reconnect
        if (!state.client || state.status !== 'Connected') {
            logger.info('Downstream not connected, attempting inline reconnect', {
                key,
                status: state.status,
            });
            await this.reconnect(key);
            state = this._downstreams.get(key)!;
        }

        if (!state.client || state.status !== 'Connected') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Downstream for "${entry.injectValue || '(default)'}" is not connected (status: ${state.status}).`,
                    },
                ],
                isError: true,
            };
        }

        try {
            const result = await state.client.callTool({
                name: toolName,
                arguments: args,
            });

            return {
                content: (result.content ?? []) as ToolCallResult['content'],
                isError: result.isError as boolean | undefined,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);

            if (
                msg.includes('401') ||
                msg.includes('403') ||
                msg.includes('Unauthorized') ||
                msg.includes('Forbidden')
            ) {
                logger.error('Auth error from downstream', {
                    key,
                    injectValue: entry.injectValue,
                    tool: toolName,
                    error: msg,
                });
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Error calling tool "${toolName}" on "${entry.injectValue}": ${msg}`,
                    },
                ],
                isError: true,
            };
        }
    }

    /**
     * Call a tool on the default downstream (plain child process with only passthroughArgs).
     * Used for tools that don't match any RouterEntry pattern.
     * Lazily creates the default downstream on first use.
     */
    async callDefault(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        logger.info('callTool (default downstream)', { toolName, argKeys: Object.keys(args) });
        return this.callTool(DEFAULT_ENTRY, toolName, args);
    }

    /**
     * Call a tool on ALL matching entries (fan-out) and merge results.
     */
    async callToolOnAll(
        entries: RouterEntry[],
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        if (entries.length === 0) {
            return {
                content: [{ type: 'text', text: 'Error: No downstream entries configured.' }],
                isError: true,
            };
        }

        const results = await Promise.allSettled(
            entries.map((entry) => this.callTool(entry, toolName, args))
        );

        const mergedContent: ToolCallResult['content'] = [];
        let hasError = false;

        for (const result of results) {
            if (result.status === 'fulfilled') {
                mergedContent.push(...result.value.content);
                if (result.value.isError) hasError = true;
            } else {
                mergedContent.push({
                    type: 'text',
                    text: `Error from one downstream: ${result.reason}`,
                });
                hasError = true;
            }
        }

        return { content: mergedContent, isError: hasError };
    }

    /**
     * Shut down all downstream connections.
     * @param force - If true, SIGKILL all children immediately (used when parent is killing us).
     */
    async shutdownAll(force = false): Promise<void> {
        // Stop the idle sweep timer first.
        if (this._idleTimer) {
            clearInterval(this._idleTimer);
            this._idleTimer = null;
        }

        logger.info('Shutting down all downstream connections...', { force });

        const shutdownPromises = [...this._downstreams.values()].map(async (state) => {
            try {
                await this._cleanupDownstream(state, force);
                logger.debug('Downstream shut down', { key: state.key });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error('Error shutting down downstream', { key: state.key, error: msg });
            }
        });

        // Overall timeout: don't let shutdown hang if children are unresponsive.
        // Force mode is instant; graceful mode gets 3s total.
        const timeoutMs = force ? 500 : 3000;
        await Promise.race([
            Promise.allSettled(shutdownPromises),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);

        this._downstreams.clear();
        logger.info('All downstream connections shut down.');
    }
}
