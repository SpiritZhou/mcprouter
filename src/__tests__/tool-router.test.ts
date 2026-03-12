/**
 * Tests for ToolRouter — tool proxying and call routing logic (new --router API).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRouter } from '../tool-router.js';
import type { DownstreamManager } from '../downstream-manager.js';
import type { RouterEntry, ToolDefinition, ToolCallResult } from '../types.js';

const CLUSTER1 = 'https://cluster1.kusto.windows.net';
const CLUSTER2 = 'https://cluster2.kusto.windows.net';

// Router entries: 2 Kusto clusters, each with pattern 'kusto_*' and different AZURE_CLIENT_ID
// Entry[0]: kusto_*.cluster-uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="client1"
//   → Child process env: { AZURE_CLIENT_ID: 'client1', ...process.env }
// Entry[1]: kusto_*.cluster-uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="client2"
//   → Child process env: { AZURE_CLIENT_ID: 'client2', ...process.env }
// Different AZURE_CLIENT_ID → different downstream keys → separate child processes
const KUSTO_ENTRIES: RouterEntry[] = [
    {
        toolPattern: 'kusto_*',
        injectParam: 'cluster-uri',
        injectValue: CLUSTER1,
        envOverrides: { AZURE_CLIENT_ID: 'client1' },
    },
    {
        toolPattern: 'kusto_*',
        injectParam: 'cluster-uri',
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
                'cluster-uri': { type: 'string', description: 'Cluster URI' },
                database: { type: 'string', description: 'Database name' },
                query: { type: 'string', description: 'KQL query' },
            },
            required: ['cluster-uri', 'database', 'query'],
        },
    },
    {
        name: 'kusto_database_list',
        description: 'List databases',
        inputSchema: {
            type: 'object',
            properties: {
                'cluster-uri': { type: 'string', description: 'Cluster URI' },
            },
            required: ['cluster-uri'],
        },
    },
    {
        name: 'kusto_cluster_list',
        description: 'List clusters (no cluster-uri — fan-out candidate)',
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
        probeToolSchemas: vi.fn(async (): Promise<ToolDefinition[]> => SAMPLE_TOOLS),
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
            expect(query!.inputSchema.properties!['cluster-uri']!.enum).toBeUndefined();
            expect(query!.description).toBe('Execute a KQL query');
        });

        it('handles empty tool list gracefully', () => {
            const emptyRouter = new ToolRouter(mockManager, KUSTO_ENTRIES);
            emptyRouter.refreshTools([]);
            expect(emptyRouter.getTools()).toHaveLength(0);
        });
    });

    describe('routeCall — routable tools', () => {
        // Tool call: kusto_query({ 'cluster-uri': CLUSTER1, database: 'mydb', query: 'T | take 10' })
        // Pattern 'kusto_*' matches 'kusto_query' → 2 entries match
        // cluster-uri=CLUSTER1 matches entry[0].injectValue → callTool(entry[0], ...)
        // Routes to child process with env { AZURE_CLIENT_ID:'client1' }
        it('routes kusto_query using cluster-uri to matching entry', async () => {
            const result = await router.routeCall('kusto_query', {
                'cluster-uri': CLUSTER1,
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBeFalsy();
            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectValue).toBe(CLUSTER1);
            expect((mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe('kusto_query');
        });

        // Tool call: kusto_query({ 'cluster-uri': CLUSTER2, ... })
        // cluster-uri=CLUSTER2 matches entry[1].injectValue → callTool(entry[1], ...)
        // Routes to child process with env { AZURE_CLIENT_ID:'client2' }
        it('routes to second cluster', async () => {
            await router.routeCall('kusto_query', {
                'cluster-uri': CLUSTER2,
                database: 'mydb',
                query: 'T | take 10',
            });

            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectValue).toBe(CLUSTER2);
        });

        // Tool call: kusto_query({ 'cluster-uri': CLUSTER1.toUpperCase(), ... })
        // Case-insensitive match → still routes to entry[0] child process
        it('normalizes inject value case-insensitively', async () => {
            const result = await router.routeCall('kusto_query', {
                'cluster-uri': CLUSTER1.toUpperCase(),
                database: 'mydb',
                query: 'T | take 10',
            });
            expect(result.isError).toBeFalsy();
        });

        // Tool call: kusto_query({ 'cluster-uri': 'https://unknown.kusto.windows.net', ... })
        // cluster-uri value not in any entry → callDefault (default child process, no env overrides)
        it('falls back to default downstream when inject value is unknown', async () => {
            const result = await router.routeCall('kusto_query', {
                'cluster-uri': 'https://unknown.kusto.windows.net',
                database: 'mydb',
                query: 'T | take 10',
            });
            expect(mockManager.callDefault).toHaveBeenCalledWith(
                'kusto_query',
                { 'cluster-uri': 'https://unknown.kusto.windows.net', database: 'mydb', query: 'T | take 10' }
            );
            expect(result.isError).toBeFalsy();
        });

        // Tool call: kusto_query({ database: 'mydb', query: ... }) — no cluster-uri provided
        // 2 entries match but no injectParam value → callToolOnAll (fan-out to both child processes)
        // Both child processes (client1 + client2) receive the same tool call
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

        // Verifies cluster-uri is preserved in forwarded args to the child process tool call
        it('ensures inject param is preserved in forwarded args', async () => {
            await router.routeCall('kusto_query', {
                'cluster-uri': CLUSTER1,
                database: 'mydb',
                query: 'T | take 10',
            });
            const forwardedArgs = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
            expect(forwardedArgs['cluster-uri']).toBe(CLUSTER1);
        });
    });

    describe('routeCall — tools with no matching pattern', () => {
        // Tool call: unrelated_tool({ foo: 'bar' })
        // Pattern 'kusto_*' does NOT match 'unrelated_tool' → 0 entries match
        // → callDefault (default child process with no env overrides, no inject)
        it('routes unrelated_tool to the default downstream (no inject)', async () => {
            await router.routeCall('unrelated_tool', { foo: 'bar' });
            expect(mockManager.callDefault).toHaveBeenCalledWith('unrelated_tool', { foo: 'bar' });
            expect(mockManager.callTool).not.toHaveBeenCalled();
            expect(mockManager.callToolOnAll).not.toHaveBeenCalled();
        });
    });

    describe('routeCall — kusto_cluster_list (kusto_* matches but no cluster-uri in schema)', () => {
        // Tool call: kusto_cluster_list({ subscriptionId: 'sub1' }) — no cluster-uri arg
        // Pattern 'kusto_*' matches → 2 entries, but no injectParam → fan-out to both child processes
        it('fans out when cluster-uri not provided', async () => {
            await router.routeCall('kusto_cluster_list', { subscriptionId: 'sub1' });
            expect(mockManager.callToolOnAll).toHaveBeenCalledWith(
                KUSTO_ENTRIES,
                'kusto_cluster_list',
                { subscriptionId: 'sub1' }
            );
        });

        // Tool call: kusto_cluster_list({ subscriptionId:'sub1', 'cluster-uri': CLUSTER1 })
        // cluster-uri provided → routes to entry[0] child process (AZURE_CLIENT_ID='client1')
        it('routes to specific cluster when cluster-uri provided', async () => {
            await router.routeCall('kusto_cluster_list', {
                subscriptionId: 'sub1',
                'cluster-uri': CLUSTER1,
            });
            const calledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(calledEntry.injectValue).toBe(CLUSTER1);
        });
    });

    describe('mixed namespaces', () => {
        // Entries: kusto_* (2 entries) + cosmos_* (1 entry)
        // cosmos_query({ account:'myaccount' }) → matches cosmos_* → callTool with cosmosEntry
        //   Child process env: {} (no env overrides for cosmos)
        // kusto_query({ 'cluster-uri': CLUSTER1 }) → matches kusto_* → callTool with entry[0]
        //   Child process env: { AZURE_CLIENT_ID:'client1' }
        // Each namespace routes independently to its own child process
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

            // kusto_query should still route via cluster-uri, not account
            vi.clearAllMocks();
            await mixedRouter.routeCall('kusto_query', { 'cluster-uri': CLUSTER1, database: 'd', query: 'q' });
            const kustoCalledEntry = (mockManager.callTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RouterEntry;
            expect(kustoCalledEntry.injectParam).toBe('cluster-uri');
        });
    });

    // -----------------------------------------------------------------------
    // lazyGetTools — lazy probing, caching, retry-on-failure
    // -----------------------------------------------------------------------

    describe('lazyGetTools', () => {
        it('probes on first call and returns tools', async () => {
            const router = new ToolRouter(mockManager, KUSTO_ENTRIES);
            const tools = await router.lazyGetTools();
            expect(tools).toEqual(SAMPLE_TOOLS);
            expect(mockManager.probeToolSchemas).toHaveBeenCalledOnce();
        });

        it('returns cached tools without re-probing on subsequent calls', async () => {
            const router = new ToolRouter(mockManager, KUSTO_ENTRIES);
            await router.lazyGetTools();
            await router.lazyGetTools();
            await router.lazyGetTools();
            expect(mockManager.probeToolSchemas).toHaveBeenCalledOnce();
        });

        it('concurrent callers share a single probe promise', async () => {
            const router = new ToolRouter(mockManager, KUSTO_ENTRIES);
            const [a, b, c] = await Promise.all([
                router.lazyGetTools(),
                router.lazyGetTools(),
                router.lazyGetTools(),
            ]);
            expect(a).toEqual(SAMPLE_TOOLS);
            expect(b).toBe(a); // same reference
            expect(c).toBe(a);
            expect(mockManager.probeToolSchemas).toHaveBeenCalledOnce();
        });

        it('retries probe when previous probe returned empty', async () => {
            const probeSpy = mockManager.probeToolSchemas as ReturnType<typeof vi.fn>;
            probeSpy.mockResolvedValueOnce([]); // first call returns empty

            const router = new ToolRouter(mockManager, KUSTO_ENTRIES);
            const first = await router.lazyGetTools();
            expect(first).toEqual([]); // empty, no tools cached

            // second call should re-probe (promise was cleared)
            const second = await router.lazyGetTools();
            expect(second).toEqual(SAMPLE_TOOLS);
            expect(probeSpy).toHaveBeenCalledTimes(2);
        });

        it('retries probe when previous probe threw an error', async () => {
            const probeSpy = mockManager.probeToolSchemas as ReturnType<typeof vi.fn>;
            probeSpy.mockRejectedValueOnce(new Error('connection refused'));

            const router = new ToolRouter(mockManager, KUSTO_ENTRIES);
            const first = await router.lazyGetTools();
            expect(first).toEqual([]); // error → returns empty

            // next call should retry
            const second = await router.lazyGetTools();
            expect(second).toEqual(SAMPLE_TOOLS);
            expect(probeSpy).toHaveBeenCalledTimes(2);
        });

        it('skips probe when tools are already populated via refreshTools', async () => {
            const router = new ToolRouter(mockManager, KUSTO_ENTRIES);
            router.refreshTools(SAMPLE_TOOLS);

            const tools = await router.lazyGetTools();
            expect(tools).toEqual(SAMPLE_TOOLS);
            expect(mockManager.probeToolSchemas).not.toHaveBeenCalled();
        });
    });
});
