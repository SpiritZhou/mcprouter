/**
 * Tests for ToolRouter — tool proxying and call routing logic (new --router API).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRouter } from '../tool-router.js';
import type { DownstreamManager } from '../downstream-manager.js';
import type { RouterEntry, ToolDefinition, ToolCallResult } from '../types.js';

const CLUSTER1 = 'https://cluster1.kusto.windows.net';
const CLUSTER2 = 'https://cluster2.kusto.windows.net';

const KUSTO_ENTRIES: RouterEntry[] = [
    {
        toolPattern: 'kusto_*',
        injectParam: 'cluster_uri',
        injectValue: CLUSTER1,
        envOverrides: { AZURE_CLIENT_ID: 'client1' },
    },
    {
        toolPattern: 'kusto_*',
        injectParam: 'cluster_uri',
        injectValue: CLUSTER2,
        envOverrides: { AZURE_CLIENT_ID: 'client2' },
    },
];

const SAMPLE_TOOLS: ToolDefinition[] = [
    {
        name: 'kusto_query',
        description: 'Execute a KQL query',
        inputSchema: {
            type: 'object',
            properties: {
                cluster_uri: { type: 'string', description: 'Cluster URI' },
                database: { type: 'string', description: 'Database name' },
                query: { type: 'string', description: 'KQL query' },
            },
            required: ['cluster_uri', 'database', 'query'],
        },
    },
    {
        name: 'kusto_database_list',
        description: 'List databases',
        inputSchema: {
            type: 'object',
            properties: {
                cluster_uri: { type: 'string', description: 'Cluster URI' },
            },
            required: ['cluster_uri'],
        },
    },
    {
        name: 'kusto_cluster_list',
        description: 'List clusters (no cluster_uri — fan-out candidate)',
        inputSchema: {
            type: 'object',
            properties: {
                subscriptionId: { type: 'string', description: 'Subscription ID' },
            },
            required: ['subscriptionId'],
        },
    },
    {
        name: 'unrelated_tool',
        description: 'A tool with no matching pattern',
        inputSchema: {
            type: 'object',
            properties: { foo: { type: 'string' } },
        },
    },
];

function createMockDownstreamManager(): DownstreamManager {
    return {
        getEntries: vi.fn(() => KUSTO_ENTRIES),
        callTool: vi.fn(async (_entry: RouterEntry, _tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'mock result' }],
            isError: false,
        })),
        callToolOnAll: vi.fn(async (_entries: RouterEntry[], _tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'merged result' }],
            isError: false,
        })),
        callDefault: vi.fn(async (_tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'default result' }],
            isError: false,
        })),
    } as unknown as DownstreamManager;
}

describe('ToolRouter', () => {
    let mockManager: DownstreamManager;
    let router: ToolRouter;

    beforeEach(() => {
        mockManager = createMockDownstreamManager();
        router = new ToolRouter(mockManager, KUSTO_ENTRIES);
        router.refreshTools(SAMPLE_TOOLS);
    });

    describe('refreshTools', () => {
        it('stores all tools unchanged (4 tools)', () => {
            expect(router.getTools()).toHaveLength(4);
        });

        it('does not modify tool schemas', () => {
            const query = router.getTools().find((t) => t.name === 'kusto_query');
            expect(query).toBeDefined();
            // No enum injected — schema is identical to SAMPLE_TOOLS
            expect(query!.inputSchema.properties!['cluster_uri']!.enum).toBeUndefined();
            expect(query!.description).toBe('Execute a KQL query');
        });

        it('handles empty tool list gracefully', () => {
            const emptyRouter = new ToolRouter(mockManager, KUSTO_ENTRIES);
            emptyRouter.refreshTools([]);
            expect(emptyRouter.getTools()).toHaveLength(0);
        });
    });

    describe('routeCall — routable tools', () => {
        it('routes kusto_query using cluster_uri to matching entry', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster_uri: CLUSTER1,
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBeFalsy();
            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectValue).toBe(CLUSTER1);
            expect((mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe('kusto_query');
        });

        it('routes to second cluster', async () => {
            await router.routeCall('kusto_query', {
                cluster_uri: CLUSTER2,
                database: 'mydb',
                query: 'T | take 10',
            });

            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectValue).toBe(CLUSTER2);
        });

        it('normalizes inject value case-insensitively', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster_uri: CLUSTER1.toUpperCase(),
                database: 'mydb',
                query: 'T | take 10',
            });
            expect(result.isError).toBeFalsy();
        });

        it('returns error when inject value is unknown', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster_uri: 'https://unknown.kusto.windows.net',
                database: 'mydb',
                query: 'T | take 10',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('not a configured');
        });

        it('fans out when inject param is missing', async () => {
            await router.routeCall('kusto_query', {
                database: 'mydb',
                query: 'T | take 10',
            });
            expect(mockManager.callToolOnAll).toHaveBeenCalledWith(
                KUSTO_ENTRIES,
                'kusto_query',
                { database: 'mydb', query: 'T | take 10' }
            );
        });

        it('ensures inject param is preserved in forwarded args', async () => {
            await router.routeCall('kusto_query', {
                cluster_uri: CLUSTER1,
                database: 'mydb',
                query: 'T | take 10',
            });
            const forwardedArgs = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
            expect(forwardedArgs['cluster_uri']).toBe(CLUSTER1);
        });
    });

    describe('routeCall — tools with no matching pattern', () => {
        it('routes unrelated_tool to the default downstream (no inject)', async () => {
            await router.routeCall('unrelated_tool', { foo: 'bar' });
            expect(mockManager.callDefault).toHaveBeenCalledWith('unrelated_tool', { foo: 'bar' });
            expect(mockManager.callTool).not.toHaveBeenCalled();
            expect(mockManager.callToolOnAll).not.toHaveBeenCalled();
        });
    });

    describe('routeCall — kusto_cluster_list (kusto_* matches but no cluster_uri in schema)', () => {
        it('fans out when cluster_uri not provided', async () => {
            await router.routeCall('kusto_cluster_list', { subscriptionId: 'sub1' });
            expect(mockManager.callToolOnAll).toHaveBeenCalledWith(
                KUSTO_ENTRIES,
                'kusto_cluster_list',
                { subscriptionId: 'sub1' }
            );
        });

        it('routes to specific cluster when cluster_uri provided', async () => {
            await router.routeCall('kusto_cluster_list', {
                subscriptionId: 'sub1',
                cluster_uri: CLUSTER1,
            });
            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectValue).toBe(CLUSTER1);
        });
    });

    describe('mixed namespaces', () => {
        it('routes cosmos_* tools to cosmos entries independently', async () => {
            const cosmosEntry: RouterEntry = {
                toolPattern: 'cosmos_*',
                injectParam: 'account',
                injectValue: 'myaccount',
                envOverrides: {},
            };
            const cosmosTool: ToolDefinition = {
                name: 'cosmos_query',
                description: 'Query Cosmos',
                inputSchema: {
                    type: 'object',
                    properties: { account: { type: 'string' }, query: { type: 'string' } },
                    required: ['account', 'query'],
                },
            };
            const mixedRouter = new ToolRouter(mockManager, [...KUSTO_ENTRIES, cosmosEntry]);
            mixedRouter.refreshTools([...SAMPLE_TOOLS, cosmosTool]);

            // cosmos_query routed via 'account' to cosmosEntry
            await mixedRouter.routeCall('cosmos_query', { account: 'myaccount', query: 'SELECT 1' });
            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectParam).toBe('account');
            expect(calledEntry.injectValue).toBe('myaccount');

            // kusto_query should still route via cluster_uri, not account
            vi.clearAllMocks();
            await mixedRouter.routeCall('kusto_query', { cluster_uri: CLUSTER1, database: 'd', query: 'q' });
            const kustoCalledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(kustoCalledEntry.injectParam).toBe('cluster_uri');
        });
    });
});
