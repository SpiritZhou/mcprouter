/**
 * DownstreamManager — spawns and manages child @azure/mcp processes.
 *
 * For each mapping, it:
 * 1. Spawns `npx -y @azure/mcp@latest server start --namespace <ns> --read-only`
 * 2. Connects an MCP Client via StdioClientTransport
 * 3. Discovers tools via tools/list
 * 4. Maintains connection state and supports reconnection
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ChildProcess } from 'node:child_process';
import type {
    ClusterMapping,
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
    mapping: ClusterMapping;
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
 * Normalizes a cluster URL for consistent matching.
 * Lowercases, removes trailing slash, ensures https:// prefix.
 */
export function normalizeClusterUrl(url: string): string {
    let normalized = url.trim().toLowerCase();
    if (!normalized.startsWith('https://') && !normalized.startsWith('http://')) {
        normalized = `https://${normalized}`;
    }
    normalized = normalized.replace(/\/+$/, '');
    return normalized;
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
    private _onDownstreamExit: ((clusterUrl: string) => void) | null = null;

    constructor(config: RouterConfig) {
        this._config = config;
    }

    /**
     * Register a callback invoked immediately when a downstream child process exits unexpectedly.
     * Used by HealthMonitor to trigger immediate reconnection instead of waiting for the next ping.
     */
    onDownstreamExit(callback: (clusterUrl: string) => void): void {
        this._onDownstreamExit = callback;
    }

    /**
     * Initialize all downstream connections.
     * Spawns child processes and discovers tools from each.
     */
    async initializeAll(): Promise<void> {
        const initPromises = this._config.mappings.map(async (mapping) => {
            const key = normalizeClusterUrl(mapping.clusterUrl);
            if (this._downstreams.has(key)) {
                logger.warn(`Duplicate cluster mapping ignored`, { cluster: key });
                return;
            }

            const state: DownstreamState = {
                mapping,
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
                logger.error(`Failed to initialize downstream for cluster`, {
                    cluster: key,
                    error: msg,
                });
                state.status = 'Failed';
            }
        });

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
     */
    private async _connectDownstream(state: DownstreamState): Promise<void> {
        const key = normalizeClusterUrl(state.mapping.clusterUrl);
        logger.info(`Connecting to downstream MCP`, { cluster: key });

        const args = [
            '-y',
            '@azure/mcp@latest',
            'server',
            'start',
            '--mode',
            'all',
            '--namespace',
            'kusto',
        ];

        if (this._config.readOnly) {
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

        // If a specific identity (UAMI resource ID or client ID) is configured for this cluster,
        // set AZURE_CLIENT_ID so the downstream uses that identity instead of the default.
        if (state.mapping.identity) {
            const clientId = extractClientIdFromIdentity(state.mapping.identity);
            if (clientId) {
                env['AZURE_CLIENT_ID'] = clientId;
                logger.debug('Setting AZURE_CLIENT_ID for downstream', {
                    cluster: key,
                    clientId,
                });
            }
        }

        const transport = new StdioClientTransport({
            command: 'npx',
            args,
            env,
        });

        const client = new Client(
            {
                name: `mcp-router-downstream-${key}`,
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
            cluster: key,
            toolCount: tools.length,
            tools: tools.map((t) => t.name),
        });

        // Monitor child process exit
        if (state.process) {
            state.process.on('exit', (code, signal) => {
                logger.warn(`Downstream process exited unexpectedly`, {
                    cluster: key,
                    code,
                    signal,
                });
                state.status = 'Disconnected';
                state.client = null;
                state.transport = null;
                state.process = null;

                // Notify the health monitor for immediate reconnection
                if (this._onDownstreamExit) {
                    this._onDownstreamExit(key);
                }
            });
        }
    }

    /**
     * Reconnect a failed/disconnected downstream.
     */
    async reconnect(clusterUrl: string): Promise<boolean> {
        const key = normalizeClusterUrl(clusterUrl);
        const state = this._downstreams.get(key);
        if (!state) {
            logger.error(`Cannot reconnect: unknown cluster`, { cluster: key });
            return false;
        }

        if (state.reconnecting) {
            logger.debug(`Already reconnecting`, { cluster: key });
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
            logger.error(`Reconnection failed`, { cluster: key, error: msg });
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
    async ping(clusterUrl: string): Promise<boolean> {
        const key = normalizeClusterUrl(clusterUrl);
        const state = this._downstreams.get(key);
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
                cluster: key,
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
     * Call a tool on a specific downstream by cluster URL.
     */
    async callTool(
        clusterUrl: string,
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const key = normalizeClusterUrl(clusterUrl);
        const state = this._downstreams.get(key);

        if (!state) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Unknown cluster "${clusterUrl}". Available clusters: ${this.getClusterUrls().join(', ')}`,
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
                        text: `Error: Downstream for cluster "${clusterUrl}" is not connected (status: ${state.status}). Try again later.`,
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
                    cluster: key,
                    identity: state.mapping.identity,
                    tool: toolName,
                    error: msg,
                });
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Error calling tool "${toolName}" on cluster "${clusterUrl}": ${msg}`,
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
            connectedDownstreams.map(async ([clusterUrl]) => {
                return this.callTool(clusterUrl, toolName, args);
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
     * Get all configured cluster URLs.
     */
    getClusterUrls(): string[] {
        return [...this._downstreams.keys()];
    }

    /**
     * Get the connection info for all downstreams.
     */
    getConnections(): DownstreamConnection[] {
        return [...this._downstreams.entries()].map(([clusterUrl, state]) => ({
            clusterUrl,
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
    getStatus(clusterUrl: string): ConnectionStatus | null {
        const key = normalizeClusterUrl(clusterUrl);
        return this._downstreams.get(key)?.status ?? null;
    }

    /**
     * Shut down all downstream connections gracefully.
     */
    async shutdownAll(): Promise<void> {
        logger.info('Shutting down all downstream connections...');

        const shutdownPromises = [...this._downstreams.values()].map(
            async (state) => {
                const key = normalizeClusterUrl(state.mapping.clusterUrl);
                try {
                    await this._cleanupDownstream(state);
                    logger.debug(`Downstream shut down`, { cluster: key });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    logger.error(`Error shutting down downstream`, {
                        cluster: key,
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
