/**
 * DownstreamManager — lazily spawns and manages child @azure/mcp processes.
 *
 * Design:
 * - One child process per RouterEntry (identified by a hash of passthroughArgs + injectParam=value)
 * - Child processes are created ON DEMAND when the first tool call targeting that entry arrives
 * - A "probe" downstream is created eagerly for the first entry to discover tool schemas
 * - Each child is spawned with the shared passthroughArgs, then globalEnv, then entry's envOverrides
 * - A "default" downstream (no inject, no extra env) is created lazily for tools with no matching entry
 */

/** Sentinel entry representing a plain @azure/mcp with only passthroughArgs — no inject, no extra env. */
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
}

export class DownstreamManager {
    private readonly _downstreams = new Map<string, DownstreamState>();
    private readonly _config: RouterConfig;

    constructor(config: RouterConfig) {
        this._config = config;
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
        const key = computeDownstreamKey(this._config.passthroughArgs, entry);

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
     * Spawn a child @azure/mcp process and connect to it.
     * Uses passthroughArgs + config.globalEnv + entry.envOverrides.
     */
    private async _connectDownstream(state: DownstreamState): Promise<void> {
        const { entry, key } = state;
        logger.info('Connecting to downstream MCP', {
            key,
            injectValue: entry.injectValue,
            toolPattern: entry.toolPattern,
        });

        // passthroughArgs are already the full list forwarded to @azure/mcp
        // e.g. ["server", "start", "--namespace", "kusto", "--mode", "all", "--read-only"]
        const mcpPkg = `@azure/mcp@${this._config.mcpVersion}`;
        const childArgs = ['-y', mcpPkg, ...this._config.passthroughArgs];

        // Build environment for the child process
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            AZURE_TOKEN_CREDENTIALS:
                process.env['AZURE_TOKEN_CREDENTIALS'] ?? 'managedidentitycredential',
        };

        if (process.env['IDENTITY_ENDPOINT']) {
            env['IDENTITY_ENDPOINT'] = process.env['IDENTITY_ENDPOINT'];
        }
        if (process.env['IDENTITY_HEADER']) {
            env['IDENTITY_HEADER'] = process.env['IDENTITY_HEADER'];
        }

        // Apply global env vars from --env (shared across all downstreams)
        for (const [k, v] of Object.entries(this._config.globalEnv)) {
            env[k] = v;
        }

        // Apply per-entry identity overrides (e.g. AZURE_CLIENT_ID per cluster), layered on top
        for (const [k, v] of Object.entries(entry.envOverrides)) {
            env[k] = v;
            logger.debug('Applying per-entry env override for downstream', { key, envKey: k });
        }

        logger.info('Spawning downstream MCP process', {
            key,
            command: 'npx',
            args: childArgs,
            env: {
                AZURE_TOKEN_CREDENTIALS: env['AZURE_TOKEN_CREDENTIALS'] ?? '(not set)',
                AZURE_CLIENT_ID: env['AZURE_CLIENT_ID'] ?? '(not set)',
                IDENTITY_ENDPOINT: env['IDENTITY_ENDPOINT'] ?? '(not set)',
                IDENTITY_HEADER: env['IDENTITY_HEADER'] ?? '(not set)',
            },
        });

        const transport = new StdioClientTransport({
            command: 'npx',
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
     */
    private async _cleanupDownstream(state: DownstreamState): Promise<void> {
        try {
            if (state.client) {
                await state.client.close();
            }
        } catch {
            // Ignore close errors
        }

        if (state.process && !state.process.killed) {
            state.process.kill('SIGTERM');

            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (state.process && !state.process.killed) {
                        state.process.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);

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
     * Call a tool on the default downstream (plain @azure/mcp with only passthroughArgs).
     * Used for tools that don't match any RouterEntry pattern.
     * Lazily creates the default downstream on first use.
     */
    async callDefault(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
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
     * Shut down all downstream connections gracefully.
     */
    async shutdownAll(): Promise<void> {
        logger.info('Shutting down all downstream connections...');

        const shutdownPromises = [...this._downstreams.values()].map(async (state) => {
            try {
                await this._cleanupDownstream(state);
                logger.debug('Downstream shut down', { key: state.key });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error('Error shutting down downstream', { key: state.key, error: msg });
            }
        });

        await Promise.allSettled(shutdownPromises);
        this._downstreams.clear();
        logger.info('All downstream connections shut down.');
    }
}
