/**
 * ToolRouter — merges tool schemas from downstream MCPs and routes
 * tools/call requests to the correct downstream based on a configurable routing key.
 *
 * Dynamically classifies tools at runtime:
 * - Tools whose schema contains the routing key property → routable (route to one downstream)
 * - Tools without the routing key → fan-out (call all downstreams, merge results)
 */

import type { DownstreamManager } from './downstream-manager.js';
import type { ToolCallResult, ToolDefinition, ToolInputSchema, PropertySchema } from './types.js';
import { normalizeKey } from './downstream-manager.js';
import { logger } from './logger.js';

export class ToolRouter {
    private readonly _downstreamManager: DownstreamManager;
    private _mergedTools: ToolDefinition[] = [];
    private _routableTools = new Set<string>();
    private _fanOutTools = new Set<string>();
    private _routingKey: string;
    private _forwardKeyAs: string;

    constructor(downstreamManager: DownstreamManager) {
        this._downstreamManager = downstreamManager;
        this._routingKey = downstreamManager.getRoutingKey();
        this._forwardKeyAs = downstreamManager.getForwardKeyAs();
        logger.info('ToolRouter initialized', {
            routingKey: this._routingKey,
            forwardKeyAs: this._forwardKeyAs,
            areEqual: this._routingKey === this._forwardKeyAs,
        });
    }

    /**
     * Build the merged tool list from downstream tools.
     * Dynamically classifies tools: if schema has the routing key property → routable, otherwise → fan-out.
     */
    refreshTools(): void {
        this._routingKey = this._downstreamManager.getRoutingKey();
        this._forwardKeyAs = this._downstreamManager.getForwardKeyAs();
        const baseTools = this._downstreamManager.getToolDefinitions();
        if (baseTools.length === 0) {
            logger.warn('No tools discovered from any downstream — tool list will be empty');
            this._mergedTools = [];
            return;
        }

        const downstreamKeys = this._downstreamManager.getDownstreamKeys();

        // Classify tools dynamically by inspecting their schemas
        this._routableTools.clear();
        this._fanOutTools.clear();
        for (const tool of baseTools) {
            if (tool.inputSchema.properties?.[this._routingKey]) {
                this._routableTools.add(tool.name);
            } else {
                this._fanOutTools.add(tool.name);
            }
        }

        logger.info('Tool classification', {
            routingKey: this._routingKey,
            routable: [...this._routableTools],
            fanOut: [...this._fanOutTools],
        });

        this._mergedTools = baseTools.map((tool) => {
            if (this._routableTools.has(tool.name)) {
                return this._enhanceRoutableTool(tool, downstreamKeys);
            }
            return this._enhanceFanOutTool(tool, downstreamKeys);
        });

        logger.info(`Tool list refreshed`, {
            toolCount: this._mergedTools.length,
            tools: this._mergedTools.map((t) => t.name),
        });
    }

    /**
     * Enhance a routable tool:
     * - Mark the routing key as required
     * - Add `enum` with available downstream keys
     * - Update description to mention routing
     */
    private _enhanceRoutableTool(tool: ToolDefinition, downstreamKeys: string[]): ToolDefinition {
        const schema = structuredClone(tool.inputSchema) as ToolInputSchema;

        // Ensure properties object exists
        if (!schema.properties) {
            schema.properties = {};
        }

        // Enhance or create the routing key property
        const existingProp = schema.properties[this._routingKey] as PropertySchema | undefined;
        schema.properties[this._routingKey] = {
            ...(existingProp ?? {}),
            type: 'string',
            description: `The ${this._routingKey} to route to. Must be one of: ${downstreamKeys.join(', ')}`,
            enum: downstreamKeys,
        };

        // Ensure routing key is required
        if (!schema.required) {
            schema.required = [];
        }
        if (!schema.required.includes(this._routingKey)) {
            schema.required.push(this._routingKey);
        }

        return {
            name: tool.name,
            description: tool.description
                ? `${tool.description} (Routed to the specified ${this._routingKey})`
                : `Tool routed to the specified ${this._routingKey}`,
            inputSchema: schema,
        };
    }

    /**
     * Enhance a fan-out tool:
     * - Optionally add the routing key parameter to filter results
     * - Update description to explain fan-out behavior
     */
    private _enhanceFanOutTool(tool: ToolDefinition, downstreamKeys: string[]): ToolDefinition {
        const schema = structuredClone(tool.inputSchema) as ToolInputSchema;

        if (!schema.properties) {
            schema.properties = {};
        }

        // Add optional routing key parameter — if provided, routes to one; otherwise fans out
        schema.properties[this._routingKey] = {
            type: 'string',
            description: `Optional: specify a ${this._routingKey} to target only that downstream. If omitted, queries all. Available: ${downstreamKeys.join(', ')}`,
            enum: downstreamKeys,
        };

        return {
            name: tool.name,
            description: tool.description
                ? `${tool.description} (Queries all available downstreams unless a specific ${this._routingKey} is specified)`
                : `Queries all available downstreams`,
            inputSchema: schema,
        };
    }

    /**
     * Get the merged tool list for tools/list response.
     */
    getTools(): ToolDefinition[] {
        return this._mergedTools;
    }

    /**
     * Route a tools/call request to the appropriate downstream(s).
     */
    async routeCall(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const isRoutable = this._routableTools.has(toolName);
        const isFanOut = this._fanOutTools.has(toolName);

        if (isRoutable) {
            return this._routeToDownstream(toolName, args);
        }

        if (isFanOut) {
            return this._routeFanOut(toolName, args);
        }

        // Unknown tool — try to route if routing key is provided, otherwise error
        logger.warn(`Unknown tool called`, { tool: toolName });
        if (args[this._routingKey]) {
            return this._routeToDownstream(toolName, args);
        }

        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Unknown tool "${toolName}". Available tools: ${this._mergedTools.map((t) => t.name).join(', ')}`,
                },
            ],
            isError: true,
        };
    }

    /**
     * Route to a specific downstream based on the routing key argument.
     */
    private async _routeToDownstream(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const routingValue = args[this._routingKey] as string | undefined;

        if (!routingValue) {
            const downstreamKeys = this._downstreamManager.getDownstreamKeys();
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: The "${this._routingKey}" parameter is required for tool "${toolName}". Available: ${downstreamKeys.join(', ')}`,
                    },
                ],
                isError: true,
            };
        }

        const normalizedValue = normalizeKey(routingValue);

        // Find matching downstream
        const downstreamKeys = this._downstreamManager.getDownstreamKeys();
        const matched = downstreamKeys.find((k) => k === normalizedValue);

        if (!matched) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: "${routingValue}" is not configured. Available: ${downstreamKeys.join(', ')}`,
                    },
                ],
                isError: true,
            };
        }

        logger.debug(`Routing tool call`, {
            tool: toolName,
            [this._routingKey]: matched,
        });

        // Transform the routing key for forwarding if forwardKeyAs differs
        const forwardArgs = this._transformRoutingKey(args);
        logger.info('Forwarding routable tool call to downstream', {
            tool: toolName,
            routingKey: this._routingKey,
            forwardKeyAs: this._forwardKeyAs,
            originalArgs: Object.keys(args),
            forwardedArgs: Object.keys(forwardArgs),
            forwardedArgsValues: forwardArgs,
        });
        return this._downstreamManager.callTool(matched, toolName, forwardArgs);
    }

    /**
     * Fan-out: call all downstreams (or a single one if routing key is specified).
     */
    private async _routeFanOut(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const routingValue = args[this._routingKey] as string | undefined;

        if (routingValue) {
            // If routing key is specified, route to just that one
            const normalizedValue = normalizeKey(routingValue);
            const downstreamKeys = this._downstreamManager.getDownstreamKeys();
            const matched = downstreamKeys.find((k) => k === normalizedValue);

            if (!matched) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: "${routingValue}" is not configured. Available: ${downstreamKeys.join(', ')}`,
                        },
                    ],
                    isError: true,
                };
            }

            // Remove the synthetic routing key arg before forwarding — the real tool doesn't have it
            const forwardArgs = { ...args };
            delete forwardArgs[this._routingKey];

            return this._downstreamManager.callTool(matched, toolName, forwardArgs);
        }

        // Fan out to all
        logger.debug(`Fan-out tool call to all downstreams`, { tool: toolName });

        // Remove the synthetic routing key arg
        const forwardArgs = { ...args };
        delete forwardArgs[this._routingKey];

        return this._downstreamManager.callToolOnAll(toolName, forwardArgs);
    }

    /**
     * Transform the routing key in args for downstream forwarding.
     * If forwardKeyAs differs from routingKey, rename the property.
     * E.g., routing on "account" but forwarding as "accountName".
     */
    private _transformRoutingKey(args: Record<string, unknown>): Record<string, unknown> {
        if (this._forwardKeyAs === this._routingKey) {
            return args;
        }

        const transformed = { ...args };
        if (this._routingKey in transformed) {
            transformed[this._forwardKeyAs] = transformed[this._routingKey];
            delete transformed[this._routingKey];
        }
        return transformed;
    }
}
