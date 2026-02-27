/**
 * Tests for ToolRouter — schema merging and call routing logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRouter } from '../tool-router.js';
import type { DownstreamManager } from '../downstream-manager.js';
import type { ToolDefinition, ToolCallResult } from '../types.js';

/**
 * Create a mock DownstreamManager with configurable cluster URLs and tools.
 */
function createMockDownstreamManager(
    clusterUrls: string[],
    tools: ToolDefinition[]
): DownstreamManager {
    return {
        getClusterUrls: vi.fn(() => clusterUrls),
        getToolDefinitions: vi.fn(() => tools),
        callTool: vi.fn(async (_cluster: string, _tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'mock result' }],
            isError: false,
        })),
        callToolOnAll: vi.fn(async (_tool: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: 'text', text: 'merged result' }],
            isError: false,
        })),
    } as unknown as DownstreamManager;
}

/** Sample Kusto tools as they come from @azure/mcp */
const SAMPLE_KUSTO_TOOLS: ToolDefinition[] = [
    {
        name: 'kusto_query',
        description: 'Execute a KQL query against an Azure Data Explorer cluster',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Kusto cluster URL' },
                database: { type: 'string', description: 'Database name' },
                query: { type: 'string', description: 'KQL query' },
            },
            required: ['cluster', 'database', 'query'],
        },
    },
    {
        name: 'kusto_database_list',
        description: 'List databases in a Kusto cluster',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Kusto cluster URL' },
            },
            required: ['cluster'],
        },
    },
    {
        name: 'kusto_table_list',
        description: 'List tables in a Kusto database',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Kusto cluster URL' },
                database: { type: 'string', description: 'Database name' },
            },
            required: ['cluster', 'database'],
        },
    },
    {
        name: 'kusto_table_schema',
        description: 'Get schema for a Kusto table',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Kusto cluster URL' },
                database: { type: 'string', description: 'Database name' },
                table: { type: 'string', description: 'Table name' },
            },
            required: ['cluster', 'database', 'table'],
        },
    },
    {
        name: 'kusto_sample',
        description: 'Get sample data from a Kusto table',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Kusto cluster URL' },
                database: { type: 'string', description: 'Database name' },
                table: { type: 'string', description: 'Table name' },
                size: { type: 'number', description: 'Sample size' },
            },
            required: ['cluster', 'database', 'table'],
        },
    },
    {
        name: 'kusto_cluster_get',
        description: 'Get info about a Kusto cluster',
        inputSchema: {
            type: 'object',
            properties: {
                cluster: { type: 'string', description: 'Kusto cluster name' },
            },
            required: ['cluster'],
        },
    },
    {
        name: 'kusto_cluster_list',
        description: 'List available Kusto clusters',
        inputSchema: {
            type: 'object',
            properties: {
                subscriptionId: { type: 'string', description: 'Azure subscription ID' },
            },
            required: ['subscriptionId'],
        },
    },
];

const CLUSTER_URLS = [
    'https://cluster1.kusto.windows.net',
    'https://cluster2.kusto.windows.net',
];

describe('ToolRouter', () => {
    let mockDownstream: DownstreamManager;
    let router: ToolRouter;

    beforeEach(() => {
        mockDownstream = createMockDownstreamManager(CLUSTER_URLS, SAMPLE_KUSTO_TOOLS);
        router = new ToolRouter(mockDownstream);
        router.refreshTools();
    });

    describe('refreshTools', () => {
        it('produces 7 merged tools', () => {
            expect(router.getTools()).toHaveLength(7);
        });

        it('makes cluster required with enum for routable tools', () => {
            const query = router.getTools().find((t) => t.name === 'kusto_query');
            expect(query).toBeDefined();
            expect(query!.inputSchema.required).toContain('cluster');
            expect(query!.inputSchema.properties!['cluster']!.enum).toEqual(CLUSTER_URLS);
        });

        it('adds optional cluster to fan-out tools', () => {
            const list = router.getTools().find((t) => t.name === 'kusto_cluster_list');
            expect(list).toBeDefined();
            // Should have cluster property but NOT required
            expect(list!.inputSchema.properties!['cluster']).toBeDefined();
            expect(list!.inputSchema.properties!['cluster']!.enum).toEqual(CLUSTER_URLS);
            // cluster should NOT be in required for fan-out tools
            expect(list!.inputSchema.required).not.toContain('cluster');
        });

        it('handles empty tool list gracefully', () => {
            const emptyMock = createMockDownstreamManager(CLUSTER_URLS, []);
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

        it('returns error when cluster is missing', async () => {
            const result = await router.routeCall('kusto_query', {
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('"cluster" parameter is required');
        });

        it('returns error when cluster is unknown', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster: 'https://unknown.kusto.windows.net',
                database: 'mydb',
                query: 'T | take 10',
            });

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('not configured');
        });

        it('normalizes cluster URL for matching', async () => {
            const result = await router.routeCall('kusto_query', {
                cluster: 'https://CLUSTER1.KUSTO.WINDOWS.NET/',
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
        it('fans out kusto_cluster_list to all downstreams when no cluster specified', async () => {
            const result = await router.routeCall('kusto_cluster_list', {
                subscriptionId: 'sub1',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callToolOnAll).toHaveBeenCalledWith(
                'kusto_cluster_list',
                { subscriptionId: 'sub1' }
            );
        });

        it('routes kusto_cluster_list to specific cluster when specified', async () => {
            const result = await router.routeCall('kusto_cluster_list', {
                subscriptionId: 'sub1',
                cluster: 'https://cluster1.kusto.windows.net',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callTool).toHaveBeenCalledWith(
                'https://cluster1.kusto.windows.net',
                'kusto_cluster_list',
                { subscriptionId: 'sub1' } // cluster stripped
            );
        });
    });

    describe('routeCall — unknown tools', () => {
        it('returns error for unknown tool without cluster', async () => {
            const result = await router.routeCall('unknown_tool', {});

            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain('Unknown tool');
        });

        it('routes unknown tool if cluster is provided', async () => {
            const result = await router.routeCall('unknown_tool', {
                cluster: 'https://cluster1.kusto.windows.net',
            });

            expect(result.isError).toBeFalsy();
            expect(mockDownstream.callTool).toHaveBeenCalled();
        });
    });
});
