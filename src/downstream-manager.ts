/**
 * DownstreamManager — spawns and manages child @azure/mcp processes.
 *
 * For each downstream mapping in each group, it:
 * 1. Spawns `npx -y @azure/mcp@latest server start --namespace <ns>`
 * 2. Connects an MCP Client via StdioClientTransport
 * 3. Discovers tools via tools/list
 * 4. Maintains connection state and supports reconnection
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ChildProcess } from 'node:child_process';
import type {
    DownstreamMapping,
    DownstreamGroupConfig,
    ConnectionStatus,
    DownstreamConnection,
    RouterConfig,
    ToolCallResult,
    ToolDefinition,
} from './types.js';
import { logger } from './logger.js';

/**
 * Internal state for a downstream connection, including the MCP client and child process.
 */
interface DownstreamState {
    mapping: DownstreamMapping;
    group: DownstreamGroupConfig;
    client: Client | null;
    transport: StdioClientTransport | null;
    process: ChildProcess | null;
    status: ConnectionStatus;
    lastHeartbeat: string | null;
    consecutiveFailures: number;
    tools: ToolDefinition[];
    reconnecting: boolean;
}

/**
 * Normalizes a downstream key for consistent matching.
 * Lowercases and trims whitespace. The key is treated as an opaque identifier.
 */
export function normalizeKey(key: string): string {
    return key.trim().toLowerCase();
}

/**
 * Extract a usable identity value from a mapping identity string.
 * Accepts a raw client ID (GUID) or an ARM resource ID for a user-assigned managed identity.
 */
function extractClientIdFromIdentity(identity: string): string | null {
    const trimmed = identity.trim();
    if (!trimmed) return null;
    return trimmed;
}

export class DownstreamManager {
    private readonly _downstreams = new Map<string, DownstreamState>();
    private readonly _config: RouterConfig;
    private _onDownstreamExit: ((key: string) => void) | null = null;

    constructor(config: RouterConfig) {
        this._config = config;
    }

    /**
     * Register a callback invoked immediately when a downstream child process exits unexpectedly.
     * Used by HealthMonitor to trigger immediate reconnection instead of waiting for the next ping.
     */
    onDownstreamExit(callback: (key: string) => void): void {
        this._onDownstreamExit = callback;
    }

    /**
     * Initialize all downstream connections across all groups.
     * Spawns child processes and discovers tools from each.
     */
    async initializeAll(): Promise<void> {
        const initPromises: Promise<void>[] = [];

        for (const group of this._config.groups) {
            for (const mapping of group.downstreams) {
                const normalizedKey = normalizeKey(mapping.key);
                if (this._downstreams.has(normalizedKey)) {
                    logger.warn(`Duplicate downstream mapping ignored`, { key: normalizedKey });
                    continue;
                }

                const state: DownstreamState = {
                    mapping,
                    group,
                    client: null,
                    transport: null,
                    process: null,
                    status: 'Connecting',
                    lastHeartbeat: null,
                    consecutiveFailures: 0,
                    tools: [],
                    reconnecting: false,
                };
                this._downstreams.set(normalizedKey, state);

                initPromises.push(
                    (async () => {
                        try {
                            await this._connectDownstream(state);
                        } catch (error) {
                            const msg = error instanceof Error ? error.message : String(error);
                            logger.error(`Failed to initialize downstream`, {
                                key: normalizedKey,
                                group: group.namespace,
                                error: msg,
                            });
                            state.status = 'Failed';
                        }
                    })()
                );
            }
        }

        await Promise.allSettled(initPromises);

        const connected = [...this._downstreams.values()].filter(
            (d) => d.status === 'Connected'
        ).length;
        logger.info(`Downstream initialization complete`, {
            total: this._downstreams.size,
            connected,
            failed: this._downstreams.size - connected,
        });
    }

    /**
     * Spawn a child @azure/mcp process and connect to it.
     * Uses the group config for namespace, mode, and readOnly settings.
     */
    private async _connectDownstream(state: DownstreamState): Promise<void> {
        const normalizedKey = normalizeKey(state.mapping.key);
        const { group } = state;
        logger.info(`Connecting to downstream MCP`, {
            key: normalizedKey,
            namespace: group.namespace,
        });

        const args = [
            '-y',
            '@azure/mcp@latest',
            'server',
            'start',
            '--mode',
            group.mode ?? 'all',
            '--namespace',
            group.namespace,
        ];

        if (group.readOnly !== false) {
            args.push('--read-only');
        }

        // Build environment variables for the child process.
        // Inherit IDENTITY_ENDPOINT and IDENTITY_HEADER from Session.Proxy,
        // and set AZURE_TOKEN_CREDENTIALS for auth. If the parent process already
        // has AZURE_TOKEN_CREDENTIALS set (e.g. for local dev), use that;
        // otherwise default to managed identity for production.
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            AZURE_TOKEN_CREDENTIALS: process.env['AZURE_TOKEN_CREDENTIALS'] ?? 'managedidentitycredential',
        };

        // Forward identity-related env vars
        if (process.env['IDENTITY_ENDPOINT']) {
            env['IDENTITY_ENDPOINT'] = process.env['IDENTITY_ENDPOINT'];
        }
        if (process.env['IDENTITY_HEADER']) {
            env['IDENTITY_HEADER'] = process.env['IDENTITY_HEADER'];
        }

        // If a specific identity (UAMI resource ID or client ID) is configured,
        // set AZURE_CLIENT_ID so the downstream uses that identity instead of the default.
        if (state.mapping.identity) {
            const clientId = extractClientIdFromIdentity(state.mapping.identity);
            if (clientId) {
                env['AZURE_CLIENT_ID'] = clientId;
                logger.debug('Setting AZURE_CLIENT_ID for downstream', {
                    key: normalizedKey,
                    clientId,
                });
            }
        }

        logger.info('Spawning downstream MCP process', {
            key: normalizedKey,
            command: 'npx',
            args,
            env: {
                AZURE_TOKEN_CREDENTIALS: env['AZURE_TOKEN_CREDENTIALS'] ?? '(not set)',
                AZURE_CLIENT_ID: env['AZURE_CLIENT_ID'] ?? '(not set)',
                IDENTITY_ENDPOINT: env['IDENTITY_ENDPOINT'] ? '(set)' : '(not set)',
                IDENTITY_HEADER: env['IDENTITY_HEADER'] ? '(set)' : '(not set)',
            },
        });

        const transport = new StdioClientTransport({
            command: 'npx',
            args,
            env,
        });

        const client = new Client(
            {
                name: `mcp-router-downstream-${normalizedKey}`,
                version: '1.0.0',
            },
            {
                capabilities: {},
            }
        );

        await client.connect(transport);

        // Discover tools
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

        logger.info(`Connected to downstream MCP`, {
            key: normalizedKey,
            namespace: group.namespace,
            toolCount: tools.length,
            tools: tools.map((t) => t.name),
        });

        // Monitor child process exit
        if (state.process) {
            state.process.on('exit', (code, signal) => {
                logger.warn(`Downstream process exited unexpectedly`, {
                    key: normalizedKey,
                    code,
                    signal,
                });
                state.status = 'Disconnected';
                state.client = null;
                state.transport = null;
                state.process = null;

                // Notify the health monitor for immediate reconnection
                if (this._onDownstreamExit) {
                    this._onDownstreamExit(normalizedKey);
                }
            });
        }
    }

    /**
     * Reconnect a failed/disconnected downstream.
     */
    async reconnect(key: string): Promise<boolean> {
        const normalizedKey = normalizeKey(key);
        const state = this._downstreams.get(normalizedKey);
        if (!state) {
            logger.error(`Cannot reconnect: unknown downstream`, { key: normalizedKey });
            return false;
        }

        if (state.reconnecting) {
            logger.debug(`Already reconnecting`, { key: normalizedKey });
            return false;
        }

        state.reconnecting = true;
        try {
            // Clean up existing connection
            await this._cleanupDownstream(state);

            // Re-connect
            await this._connectDownstream(state);
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Reconnection failed`, { key: normalizedKey, error: msg });
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

            // Force kill after 5 seconds
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
     * Ping a downstream for health checking.
     */
    async ping(key: string): Promise<boolean> {
        const normalizedKey = normalizeKey(key);
        const state = this._downstreams.get(normalizedKey);
        if (!state || !state.client || state.status !== 'Connected') {
            return false;
        }

        try {
            let timeoutId: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error('Ping timeout')),
                    this._config.pingTimeoutSeconds * 1000
                );
            });

            try {
                await Promise.race([state.client.ping(), timeoutPromise]);
            } finally {
                clearTimeout(timeoutId!);
            }

            state.lastHeartbeat = new Date().toISOString();
            state.consecutiveFailures = 0;
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            state.consecutiveFailures++;
            logger.warn(`Ping failed`, {
                key: normalizedKey,
                consecutiveFailures: state.consecutiveFailures,
                error: msg,
            });

            if (state.consecutiveFailures >= 3) {
                state.status = 'Disconnected';
            } else {
                state.status = 'Failed';
            }
            return false;
        }
    }

    /**
     * Call a tool on a specific downstream by key.
     */
    async callTool(
        key: string,
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const normalizedKey = normalizeKey(key);
        const state = this._downstreams.get(normalizedKey);

        if (!state) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Unknown downstream "${key}". Available: ${this.getDownstreamKeys().join(', ')}`,
                    },
                ],
                isError: true,
            };
        }

        if (!state.client || state.status !== 'Connected') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Downstream "${key}" is not connected (status: ${state.status}). Try again later.`,
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

            // Check for auth errors
            if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('Forbidden')) {
                logger.error(`Auth error from downstream`, {
                    key: normalizedKey,
                    identity: state.mapping.identity,
                    tool: toolName,
                    error: msg,
                });
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Error calling tool "${toolName}" on "${key}": ${msg}`,
                    },
                ],
                isError: true,
            };
        }
    }

    /**
     * Call a tool on ALL downstreams (fan-out) and merge results.
     */
    async callToolOnAll(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const connectedDownstreams = [...this._downstreams.entries()].filter(
            ([, state]) => state.status === 'Connected' && state.client
        );

        if (connectedDownstreams.length === 0) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Error: No downstream MCP servers are currently connected.',
                    },
                ],
                isError: true,
            };
        }

        const results = await Promise.allSettled(
            connectedDownstreams.map(async ([key]) => {
                return this.callTool(key, toolName, args);
            })
        );

        const mergedContent: ToolCallResult['content'] = [];
        let hasError = false;

        for (const result of results) {
            if (result.status === 'fulfilled') {
                mergedContent.push(...result.value.content);
                if (result.value.isError) {
                    hasError = true;
                }
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
     * Get all configured downstream keys.
     */
    getDownstreamKeys(): string[] {
        return [...this._downstreams.keys()];
    }

    /**
     * Get the routing key property name. All groups must use the same routing key
     * for the current single-router model; returns the first group's routing key.
     */
    getRoutingKey(): string {
        if (this._config.groups.length > 0) {
            return this._config.groups[0]!.routingKey;
        }
        return 'cluster-uri'; // fallback default — matches @azure/mcp kusto tool schema
    }

    /**
     * Get the forwardKeyAs property name. When forwarding the routing key value
     * to the downstream, use this name instead of the routing key.
     *
     * Returns the routing key if no override is configured.
     */
    getForwardKeyAs(): string {
        if (this._config.groups.length > 0) {
            const group = this._config.groups[0]!;

            // Explicit config takes priority
            if (group.forwardKeyAs) {
                return group.forwardKeyAs;
            }

            return group.routingKey;
        }
        return this.getRoutingKey();
    }

    /**
     * Get the connection info for all downstreams.
     */
    getConnections(): DownstreamConnection[] {
        return [...this._downstreams.entries()].map(([key, state]) => ({
            key,
            group: state.group.namespace,
            identity: state.mapping.identity,
            status: state.status,
            lastHeartbeat: state.lastHeartbeat,
            consecutiveFailures: state.consecutiveFailures,
            tools: state.tools,
        }));
    }

    /**
     * Get tools from the first connected downstream.
     * All downstreams expose the same tools, so we only need one set.
     */
    getToolDefinitions(): ToolDefinition[] {
        for (const state of this._downstreams.values()) {
            if (state.status === 'Connected' && state.tools.length > 0) {
                return state.tools;
            }
        }
        return [];
    }

    /**
     * Get the status of a specific downstream.
     */
    getStatus(key: string): ConnectionStatus | null {
        const normalizedKey = normalizeKey(key);
        return this._downstreams.get(normalizedKey)?.status ?? null;
    }

    /**
     * Shut down all downstream connections gracefully.
     */
    async shutdownAll(): Promise<void> {
        logger.info('Shutting down all downstream connections...');

        const shutdownPromises = [...this._downstreams.values()].map(
            async (state) => {
                const normalizedKey = normalizeKey(state.mapping.key);
                try {
                    await this._cleanupDownstream(state);
                    logger.debug(`Downstream shut down`, { key: normalizedKey });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    logger.error(`Error shutting down downstream`, {
                        key: normalizedKey,
                        error: msg,
                    });
                }
            }
        );

        await Promise.allSettled(shutdownPromises);
        this._downstreams.clear();
        logger.info('All downstream connections shut down.');
    }
}
