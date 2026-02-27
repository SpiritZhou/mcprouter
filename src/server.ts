/**
 * MCP Server — the stdio-based MCP server interface.
 *
 * Exposes the merged tools via the standard MCP protocol:
 * - tools/list → returns merged tool schemas from ToolRouter
 * - tools/call → delegates to ToolRouter for routing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolRouter } from './tool-router.js';
import type { ToolDefinition, PropertySchema } from './types.js';
import { logger } from './logger.js';

/**
 * Creates and starts the MCP server.
 * The server registers all tools from the ToolRouter and delegates calls.
 */
export async function createAndStartServer(toolRouter: ToolRouter): Promise<{
    server: McpServer;
    transport: StdioServerTransport;
}> {
    const server = new McpServer(
        {
            name: 'mcp-router',
            version: '1.0.0',
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // Register each tool from the router
    const tools = toolRouter.getTools();
    for (const tool of tools) {
        registerTool(server, tool, toolRouter);
    }

    logger.info(`MCP server created`, { registeredTools: tools.length });

    // Start the stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP server connected via stdio transport');

    return { server, transport };
}

/**
 * Convert a tool's JSON Schema inputSchema to a Zod schema for McpServer.tool() registration.
 */
function buildZodSchema(inputSchema: ToolDefinition['inputSchema']): Record<string, z.ZodTypeAny> {
    const zodProps: Record<string, z.ZodTypeAny> = {};
    const properties = inputSchema.properties ?? {};
    const required = new Set(inputSchema.required ?? []);

    for (const [propName, propSchema] of Object.entries(properties)) {
        let zodType = jsonSchemaPropertyToZod(propSchema);

        if (!required.has(propName)) {
            zodType = zodType.optional();
        }

        zodProps[propName] = zodType;
    }

    return zodProps;
}

/**
 * Convert a JSON Schema property to a Zod type.
 */
function jsonSchemaPropertyToZod(prop: PropertySchema): z.ZodTypeAny {
    const description = prop.description;

    switch (prop.type) {
        case 'string': {
            let schema: z.ZodTypeAny;
            if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
                // Create enum schema
                schema = z.enum(prop.enum as [string, ...string[]]);
            } else {
                schema = z.string();
            }
            return description ? schema.describe(description) : schema;
        }
        case 'number':
        case 'integer': {
            const schema = z.number();
            return description ? schema.describe(description) : schema;
        }
        case 'boolean': {
            const schema = z.boolean();
            return description ? schema.describe(description) : schema;
        }
        case 'array': {
            const itemSchema = prop.items
                ? jsonSchemaPropertyToZod(prop.items)
                : z.unknown();
            const schema = z.array(itemSchema);
            return description ? schema.describe(description) : schema;
        }
        default: {
            // Fallback to unknown for complex/untyped schemas
            const schema = z.unknown();
            return description ? schema.describe(description) : schema;
        }
    }
}

/**
 * Register a single tool on the MCP server.
 */
function registerTool(
    server: McpServer,
    tool: ToolDefinition,
    toolRouter: ToolRouter
): void {
    const zodSchema = buildZodSchema(tool.inputSchema);

    server.tool(
        tool.name,
        tool.description ?? `Tool: ${tool.name}`,
        zodSchema,
        async (args) => {
            logger.debug(`Tool call received`, {
                tool: tool.name,
                args: Object.keys(args),
            });

            const result = await toolRouter.routeCall(
                tool.name,
                args as Record<string, unknown>
            );

            return {
                content: result.content.map((c) => ({
                    type: c.type as 'text',
                    text: c.text ?? '',
                })),
                isError: result.isError,
            };
        }
    );

    logger.debug(`Registered tool`, { tool: tool.name });
}
