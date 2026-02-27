/**
 * ToolRouter — merges tool schemas from downstream MCPs and routes
 * tools/call requests to the correct downstream based on the routing key parameter.
 *
 * Dynamically classifies tools at runtime:
 * - Tools whose schema contains a 'cluster' property → routable (route to one downstream)
 * - Tools without 'cluster' → fan-out (call all downstreams, merge results)
 */

import type { DownstreamManager } from './downstream-manager.js';
import type { ToolCallResult, ToolDefinition, ToolInputSchema, PropertySchema } from './types.js';
import { normalizeClusterUrl } from './downstream-manager.js';
import { logger } from './logger.js';

export class ToolRouter {
    private readonly _downstreamManager: DownstreamManager;
    private _mergedTools: ToolDefinition[] = [];
    private _routableTools = new Set<string>();
    private _fanOutTools = new Set<string>();

    constructor(downstreamManager: DownstreamManager) {
        this._downstreamManager = downstreamManager;
    }

    /**
     * Build the merged tool list from downstream tools.
     * Dynamically classifies tools: if schema has a 'cluster' property → routable, otherwise → fan-out.
     */
    refreshTools(): void {
        const baseTools = this._downstreamManager.getToolDefinitions();
        if (baseTools.length === 0) {
            logger.warn('No tools discovered from any downstream — tool list will be empty');
            this._mergedTools = [];
            return;
        }

        const clusterUrls = this._downstreamManager.getClusterUrls();

        // Classify tools dynamically by inspecting their schemas
        this._routableTools.clear();
        this._fanOutTools.clear();
        for (const tool of baseTools) {
            if (tool.inputSchema.properties?.['cluster']) {
                this._routableTools.add(tool.name);
            } else {
                this._fanOutTools.add(tool.name);
            }
        }

        logger.info('Tool classification', {
            routable: [...this._routableTools],
            fanOut: [...this._fanOutTools],
        });

        this._mergedTools = baseTools.map((tool) => {
            if (this._routableTools.has(tool.name)) {
                return this._enhanceRoutableTool(tool, clusterUrls);
            }
            return this._enhanceFanOutTool(tool, clusterUrls);
        });

        logger.info(`Tool list refreshed`, {
            toolCount: this._mergedTools.length,
            tools: this._mergedTools.map((t) => t.name),
        });
    }

    /**
     * Enhance a cluster-routable tool:
     * - Mark `cluster` as required
     * - Add `enum` with available cluster URLs
     * - Update description to mention routing
     */
    private _enhanceRoutableTool(tool: ToolDefinition, clusterUrls: string[]): ToolDefinition {
        const schema = structuredClone(tool.inputSchema) as ToolInputSchema;

        // Ensure properties object exists
        if (!schema.properties) {
            schema.properties = {};
        }

        // Enhance or create the cluster property
        const existingCluster = schema.properties['cluster'] as PropertySchema | undefined;
        schema.properties['cluster'] = {
            ...(existingCluster ?? {}),
            type: 'string',
            description: `The Kusto cluster URL to query. Must be one of the available clusters: ${clusterUrls.join(', ')}`,
            enum: clusterUrls,
        };

        // Ensure cluster is required
        if (!schema.required) {
            schema.required = [];
        }
        if (!schema.required.includes('cluster')) {
            schema.required.push('cluster');
        }

        return {
            name: tool.name,
            description: tool.description
                ? `${tool.description} (Routed to the specified cluster)`
                : `Kusto tool routed to the specified cluster`,
            inputSchema: schema,
        };
    }

    /**
     * Enhance a fan-out tool:
     * - Optionally add a `cluster` parameter to filter results
     * - Update description to explain fan-out behavior
     */
    private _enhanceFanOutTool(tool: ToolDefinition, clusterUrls: string[]): ToolDefinition {
        const schema = structuredClone(tool.inputSchema) as ToolInputSchema;

        if (!schema.properties) {
            schema.properties = {};
        }

        // Add optional cluster parameter — if provided, routes to one; otherwise fans out
        schema.properties['cluster'] = {
            type: 'string',
            description: `Optional: specify a Kusto cluster URL to query only that cluster. If omitted, queries all clusters. Available: ${clusterUrls.join(', ')}`,
            enum: clusterUrls,
        };

        return {
            name: tool.name,
            description: tool.description
                ? `${tool.description} (Queries all available clusters unless a specific cluster is specified)`
                : `Lists Kusto clusters across all available connections`,
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
            return this._routeToCluster(toolName, args);
        }

        if (isFanOut) {
            return this._routeFanOut(toolName, args);
        }

        // Unknown tool — try to route if cluster is provided, otherwise error
        logger.warn(`Unknown tool called`, { tool: toolName });
        if (args['cluster']) {
            return this._routeToCluster(toolName, args);
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
     * Route to a specific downstream based on the `cluster` argument.
     */
    private async _routeToCluster(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const cluster = args['cluster'] as string | undefined;

        if (!cluster) {
            const clusterUrls = this._downstreamManager.getClusterUrls();
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: The "cluster" parameter is required for tool "${toolName}". Available clusters: ${clusterUrls.join(', ')}`,
                    },
                ],
                isError: true,
            };
        }

        const normalizedCluster = normalizeClusterUrl(cluster);

        // Find matching downstream
        const clusterUrls = this._downstreamManager.getClusterUrls();
        const matchedCluster = clusterUrls.find((url) => url === normalizedCluster);

        if (!matchedCluster) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Cluster "${cluster}" is not configured. Available clusters: ${clusterUrls.join(', ')}`,
                    },
                ],
                isError: true,
            };
        }

        logger.debug(`Routing tool call`, {
            tool: toolName,
            cluster: matchedCluster,
        });

        return this._downstreamManager.callTool(matchedCluster, toolName, args);
    }

    /**
     * Fan-out: call all downstreams (or a single one if cluster is specified).
     */
    private async _routeFanOut(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        const cluster = args['cluster'] as string | undefined;

        if (cluster) {
            // If cluster is specified, route to just that one
            const normalizedCluster = normalizeClusterUrl(cluster);
            const clusterUrls = this._downstreamManager.getClusterUrls();
            const matchedCluster = clusterUrls.find((url) => url === normalizedCluster);

            if (!matchedCluster) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: Cluster "${cluster}" is not configured. Available clusters: ${clusterUrls.join(', ')}`,
                        },
                    ],
                    isError: true,
                };
            }

            // Remove the synthetic cluster arg before forwarding — the real tool doesn't have it
            const forwardArgs = { ...args };
            delete forwardArgs['cluster'];

            return this._downstreamManager.callTool(matchedCluster, toolName, forwardArgs);
        }

        // Fan out to all
        logger.debug(`Fan-out tool call to all downstreams`, { tool: toolName });

        // Remove the synthetic cluster arg
        const forwardArgs = { ...args };
        delete forwardArgs['cluster'];

        return this._downstreamManager.callToolOnAll(toolName, forwardArgs);
    }
}
