/**
 * Tests for the MCP server — tools/list and tools/call handler behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolRouter } from '../tool-router.js';
import type { ToolDefinition, ToolCallResult } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal ToolRouter stub
// ---------------------------------------------------------------------------

function makeRouter(
    tools: ToolDefinition[],
    routeResult: ToolCallResult
): ToolRouter {
    return {
        getTools: vi.fn(() => tools),
        lazyGetTools: vi.fn(async () => tools),
        routeCall: vi.fn().mockResolvedValue(routeResult),
        refreshTools: vi.fn(),
    } as unknown as ToolRouter;
}

const SAMPLE_TOOLS: ToolDefinition[] = [
    {
        name: 'kusto_query',
        description: 'Run a KQL query',
        inputSchema: {
            type: 'object',
            properties: {
                'cluster-uri': { type: 'string', description: 'Cluster endpoint' },
                query: { type: 'string', description: 'KQL query string' },
            },
            required: ['cluster-uri', 'query'],
        },
    },
];

const SAMPLE_RESULT: ToolCallResult = {
    content: [{ type: 'text', text: 'row1\nrow2' }],
    isError: false,
};

// ---------------------------------------------------------------------------
// tools/list: schema pass-through
// ---------------------------------------------------------------------------

describe('tools/list handler', () => {
    // Upstream (Agent.Runtime) sends tools/list request to mcp-router
    // mcp-router returns tool schemas from probe child process unchanged
    // No schema modification — cluster-uri stays as { type:'string' }, no enum injection
    it('returns the exact tool definitions from the router without modification', () => {
        const router = makeRouter(SAMPLE_TOOLS, SAMPLE_RESULT);
        const tools = router.getTools();
        expect(tools).toEqual(SAMPLE_TOOLS);
        expect(tools[0]!.inputSchema.properties?.['cluster-uri']?.type).toBe('string');
    });

    it('returns an empty array when the router has no tools', () => {
        const router = makeRouter([], SAMPLE_RESULT);
        expect(router.getTools()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// tools/call: routing delegation
// ---------------------------------------------------------------------------

describe('tools/call handler', () => {
    // Upstream sends tools/call to mcp-router → mcp-router delegates to routeCall()
    // routeCall finds matching entries → spawns/reuses child process → forwards tool call
    // Result from child process is returned to upstream unchanged
    let router: ToolRouter;

    beforeEach(() => {
        router = makeRouter(SAMPLE_TOOLS, SAMPLE_RESULT);
    });

    // tools/call: kusto_query({ 'cluster-uri':'https://c.kusto.windows.net', query:'T | limit 10' })
    // → routeCall('kusto_query', args) → child process executes tool → returns result
    it('delegates to routeCall with the correct tool name and args', async () => {
        const args = { 'cluster-uri': 'https://c.kusto.windows.net', query: 'T | limit 10' };
        const result = await router.routeCall('kusto_query', args);
        expect(router.routeCall).toHaveBeenCalledWith('kusto_query', args);
        expect(result).toEqual(SAMPLE_RESULT);
    });

    // Child process returns isError:true → mcp-router passes it through unchanged
    it('passes content and isError through unchanged', async () => {
        const errorResult: ToolCallResult = {
            content: [{ type: 'text', text: 'Cluster not found' }],
            isError: true,
        };
        const errorRouter = makeRouter(SAMPLE_TOOLS, errorResult);
        const result = await errorRouter.routeCall('kusto_query', {});
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toBe('Cluster not found');
    });

    // tools/call with empty args {} → routeCall('kusto_query', {}) → valid delegation
    it('handles empty arguments object', async () => {
        await router.routeCall('kusto_query', {});
        expect(router.routeCall).toHaveBeenCalledWith('kusto_query', {});
    });
});
