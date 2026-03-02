/**
 * Tests for ToolRouter — schema merging and call routing logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRouter } from '../tool-router.js';
import type { DownstreamManager } from '../downstream-manager.js';
import type { ToolDefinition, ToolCallResult } from '../types.js';

/**
 * Create a mock DownstreamManager with configurable downstream keys, tools, and routing key.
 */
function createMockDownstreamManager(
    downstreamKeys: string[],
    tools: ToolDefinition[],
    routingKey = 'cluster',
    forwardKeyAs?: string
): DownstreamManager {
    return {
        getDownstreamKeys: vi.fn(() => downstreamKeys),
        getToolDefinitions: vi.fn(() => tools),
        getRoutingKey: vi.fn(() => routingKey),
        getForwardKeyAs: vi.fn(() => forwardKeyAs ?? routingKey),
        callTool: vi.fn(async (_key: string, _tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'mock result' }],
            isError: false,
        })),
        callToolOnAll: vi.fn(async (_tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'merged result' }],
            isError: false,
        })),
    } as unknown as DownstreamManager;
}

/** Sample tools with a 'cluster' routing key (like Kusto @azure/mcp) */
const SAMPLE_ROUTABLE_TOOLS: ToolDefinition[] = [
    {
        name: 'kusto_query',
        description: 'Execute a KQL query against an Azure Data Explorer cluster',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Cluster identifier' },
                database: { type: 'string', description: 'Database name' },
                query: { type: 'string', description: 'KQL query' },
            },
            required: ['cluster', 'database', 'query'],
        },
    },
    {
        name: 'kusto_database_list',
        description: 'List databases in a cluster',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Cluster identifier' },
            },
            required: ['cluster'],
        },
    },
    {
        name: 'kusto_table_list',
        description: 'List tables in a database',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Cluster identifier' },
                database: { type: 'string', description: 'Database name' },
            },
            required: ['cluster', 'database'],
        },
    },
    {
        name: 'kusto_table_schema',
        description: 'Get schema for a table',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Cluster identifier' },
                database: { type: 'string', description: 'Database name' },
                table: { type: 'string', description: 'Table name' },
            },
            required: ['cluster', 'database', 'table'],
        },
    },
    {
        name: 'kusto_sample',
        description: 'Get sample data from a table',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Cluster identifier' },
                database: { type: 'string', description: 'Database name' },
                table: { type: 'string', description: 'Table name' },
                size: { type: 'number', description: 'Sample size' },
            },
            required: ['cluster', 'database', 'table'],
        },
    },
    {
        name: 'kusto_cluster_get',
        description: 'Get info about a cluster',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Cluster name' },
            },
            required: ['cluster'],
        },
    },
    {
        name: 'kusto_cluster_list',
        description: 'List available clusters',
        inputSchema: {
            type: 'object',
            properties: {
                subscriptionId: { type: 'string', description: 'Azure subscription ID' },
            },
            required: ['subscriptionId'],
        },
    },
];

const DOWNSTREAM_KEYS = [
    'https://cluster1.kusto.windows.net',
    'https://cluster2.kusto.windows.net',
];

describe('ToolRouter', () => {
    let mockDownstream: DownstreamManager;
    let router: ToolRouter;

    beforeEach(() => {
        mockDownstream = createMockDownstreamManager(DOWNSTREAM_KEYS, SAMPLE_ROUTABLE_TOOLS);
        router = new ToolRouter(mockDownstream);
        router.refreshTools();
    });

    describe('refreshTools', () => {
        it('produces 7 merged tools', () => {
            expect(router.getTools()).toHaveLength(7);
        });

        it('makes routing key required with enum for routable tools', () => {
            const query = router.getTools().find((t) => t.name === 'kusto_query');
            expect(query).toBeDefined();
            expect(query!.inputSchema.required).toContain('cluster');
            expect(query!.inputSchema.properties!['cluster']!.enum).toEqual(DOWNSTREAM_KEYS);
        });

        it('adds optional routing key to fan-out tools', () => {
            const list = router.getTools().find((t) => t.name === 'kusto_cluster_list');
            expect(list).toBeDefined();
            // Should have routing key property but NOT required
            expect(list!.inputSchema.properties!['cluster']).toBeDefined();
            expect(list!.inputSchema.properties!['cluster']!.enum).toEqual(DOWNSTREAM_KEYS);
            // routing key should NOT be in required for fan-out tools
            expect(list!.inputSchema.required).not.toContain('cluster');
        });

        it('handles empty tool list gracefully', () => {
            const emptyMock = createMockDownstreamManager(DOWNSTREAM_KEYS, []);
            const emptyRouter = new ToolRouter(emptyMock);
            emptyRouter.refreshTools();
            expect(emptyRouter.getTools()).toHaveLength(0);
        });
    });

    describe('routeCall — routable tools', () => {
        it('routes kusto_query to the correct downstream', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster: 'https://cluster1.kusto.windows.net',
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callTool).toHaveBeenCalledWith(
                'https://cluster1.kusto.windows.net',
                'kusto_query',
                {
                    cluster: 'https://cluster1.kusto.windows.net',
                    database: 'mydb',
                    query: 'T | take 10',
                }
            );
        });

        it('returns error when routing key is missing', async () => {
            const result = await router.routeCall('kusto_query', {
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('"cluster" parameter is required');
        });

        it('returns error when routing key value is unknown', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster: 'https://unknown.kusto.windows.net',
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('not configured');
        });

        it('normalizes routing key value for matching', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster: 'HTTPS://CLUSTER1.KUSTO.WINDOWS.NET',
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callTool).toHaveBeenCalledWith(
                'https://cluster1.kusto.windows.net',
                'kusto_query',
                expect.any(Object)
            );
        });
    });

    describe('routeCall — fan-out tools', () => {
        it('fans out kusto_cluster_list to all downstreams when no routing key specified', async () => {
            const result = await router.routeCall('kusto_cluster_list', {
                subscriptionId: 'sub1',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callToolOnAll).toHaveBeenCalledWith(
                'kusto_cluster_list',
                { subscriptionId: 'sub1' }
            );
        });

        it('routes kusto_cluster_list to specific downstream when routing key specified', async () => {
            const result = await router.routeCall('kusto_cluster_list', {
                subscriptionId: 'sub1',
                cluster: 'https://cluster1.kusto.windows.net',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callTool).toHaveBeenCalledWith(
                'https://cluster1.kusto.windows.net',
                'kusto_cluster_list',
                { subscriptionId: 'sub1' } // routing key stripped
            );
        });
    });

    describe('routeCall — unknown tools', () => {
        it('returns error for unknown tool without routing key', async () => {
            const result = await router.routeCall('unknown_tool', {});

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('Unknown tool');
        });

        it('routes unknown tool if routing key is provided', async () => {
            const result = await router.routeCall('unknown_tool', {
                cluster: 'https://cluster1.kusto.windows.net',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callTool).toHaveBeenCalled();
        });
    });

    describe('custom routing key', () => {
        it('uses a custom routing key for classification and routing', async () => {
            const tools: ToolDefinition[] = [
                {
                    name: 'cosmos_query',
                    description: 'Query a Cosmos DB',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            account: { type: 'string', description: 'Account name' },
                            query: { type: 'string', description: 'SQL query' },
                        },
                        required: ['account', 'query'],
                    },
                },
                {
                    name: 'cosmos_list_databases',
                    description: 'List databases',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
            ];
            const keys = ['eastus:myaccount', 'westus:otheraccount'];
            const mock = createMockDownstreamManager(keys, tools, 'account');
            const customRouter = new ToolRouter(mock);
            customRouter.refreshTools();

            const mergedTools = customRouter.getTools();

            // cosmos_query has 'account' → routable
            const queryTool = mergedTools.find((t) => t.name === 'cosmos_query');
            expect(queryTool!.inputSchema.properties!['account']!.enum).toEqual(keys);
            expect(queryTool!.inputSchema.required).toContain('account');

            // cosmos_list_databases has no 'account' → fan-out, gets optional 'account'
            const listTool = mergedTools.find((t) => t.name === 'cosmos_list_databases');
            expect(listTool!.inputSchema.properties!['account']).toBeDefined();
            expect(listTool!.inputSchema.properties!['account']!.enum).toEqual(keys);

            // Route a call using the custom routing key
            const result = await customRouter.routeCall('cosmos_query', {
                account: 'eastus:myaccount',
                query: 'SELECT * FROM c',
            });
            expect(result.isError).toBeFalsy();
            expect(mock.callTool).toHaveBeenCalledWith(
                'eastus:myaccount',
                'cosmos_query',
                { account: 'eastus:myaccount', query: 'SELECT * FROM c' }
            );
        });
    });

    describe('forwardKeyAs', () => {
        it('renames the routing key when forwarding to downstream', async () => {
            // Route on "account" but forward as "accountName" to downstream
            const tools: ToolDefinition[] = [
                {
                    name: 'cosmos_query',
                    description: 'Query an account',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            account: { type: 'string', description: 'Account' },
                            query: { type: 'string', description: 'SQL query' },
                        },
                        required: ['account', 'query'],
                    },
                },
            ];
            const keys = ['eastus:myaccount'];
            const mock = createMockDownstreamManager(keys, tools, 'account', 'accountName');
            const fwdRouter = new ToolRouter(mock);
            fwdRouter.refreshTools();

            const result = await fwdRouter.routeCall('cosmos_query', {
                account: 'eastus:myaccount',
                query: 'SELECT * FROM c',
            });

            expect(result.isError).toBeFalsy();
            // The "account" key should be renamed to "accountName" in the forwarded args
            expect(mock.callTool).toHaveBeenCalledWith(
                'eastus:myaccount',
                'cosmos_query',
                { accountName: 'eastus:myaccount', query: 'SELECT * FROM c' }
            );
        });

        it('strips routing key and renames in fan-out with specific target', async () => {
            const tools: ToolDefinition[] = [
                {
                    name: 'cosmos_account_list',
                    description: 'List accounts',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            subscriptionId: { type: 'string', description: 'Sub ID' },
                        },
                        required: ['subscriptionId'],
                    },
                },
            ];
            const keys = ['eastus:myaccount'];
            const mock = createMockDownstreamManager(keys, tools, 'account', 'accountName');
            const fwdRouter = new ToolRouter(mock);
            fwdRouter.refreshTools();

            // Fan-out tool with account specified — should strip account (synthetic) from forwarded args
            const result = await fwdRouter.routeCall('cosmos_account_list', {
                subscriptionId: 'sub1',
                account: 'eastus:myaccount',
            });

            expect(result.isError).toBeFalsy();
            // Fan-out with specific target: routing key is stripped (it's synthetic), NOT renamed
            expect(mock.callTool).toHaveBeenCalledWith(
                'eastus:myaccount',
                'cosmos_account_list',
                { subscriptionId: 'sub1' }
            );
        });
    });
});
