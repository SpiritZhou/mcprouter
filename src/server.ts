/**
 * MCP Server — the stdio-based MCP server interface.
 *
 * Exposes the merged tools via the standard MCP protocol:
 * - tools/list → returns merged tool schemas from ToolRouter (pass-through, no conversion)
 * - tools/call → delegates to ToolRouter for routing
 *
 * Uses the low-level Server + setRequestHandler instead of McpServer to avoid
 * the JSON Schema → Zod → JSON Schema round-trip. The router is a pure proxy,
 * so upstream schema validation is redundant — downstream validates anyway.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRouter } from './tool-router.js';
import { logger } from './logger.js';

/**
 * Creates and starts the MCP server.
 * Registers raw stdio handlers for tools/list and tools/call.
 */
export async function createAndStartServer(toolRouter: ToolRouter): Promise<{
    server: Server;
    transport: StdioServerTransport;
}> {
    const server = new Server(
        { name: 'mcp-router', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    // tools/list — forward tool definitions directly from the router (JSON Schema, no conversion)
    server.setRequestHandler(ListToolsRequestSchema, () => {
        const tools = toolRouter.getTools();
        logger.info('tools/list request', { toolCount: tools.length });
        return { tools };
    });

    // tools/call — route to the appropriate downstream
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        logger.info('tools/call request', { tool: name, args: Object.keys(args ?? {}) });

        const result = await toolRouter.routeCall(name, (args ?? {}) as Record<string, unknown>);
        return {
            content: result.content,
            isError: result.isError,
        };
    });

    logger.info('MCP server created', { registeredTools: toolRouter.getTools().length });

    // Start the stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP server connected via stdio transport');

    return { server, transport };
}
