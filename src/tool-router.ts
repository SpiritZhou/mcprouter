/**
 * ToolRouter — proxies tool schemas from the probe downstream and routes
 * tools/call requests to the correct downstream based on RouterEntry patterns.
 *
 * Routing logic (per tool call):
 * 1. Find all RouterEntries whose toolPattern (glob) matches the tool name.
 * 2. If none match → fan-out to all entries.
 * 3. injectParam value present in args → route to that specific downstream.
 * 4. Single match, no injectParam in args → auto-inject the value and call it.
 * 5. Multiple matches, no injectParam in args → fan-out to all matching entries.
 *
 * Tools are returned as-is from the probe downstream (no schema modification).
 * The DownstreamManager's hash-keyed cache (hashcode → downstream) handles lazy creation.
 */

import type { DownstreamManager } from './downstream-manager.js';
import type { RouterEntry, ToolCallResult, ToolDefinition } from './types.js';

import { matchesPattern } from './router-parser.js';
import { logger } from './logger.js';

export class ToolRouter {
    private readonly _downstreamManager: DownstreamManager;
    private readonly _entries: RouterEntry[];
    private _tools: ToolDefinition[] = [];

    constructor(downstreamManager: DownstreamManager, entries: RouterEntry[]) {
        this._downstreamManager = downstreamManager;
        this._entries = entries;
    }

    /**
     * Store the tool list from the probe downstream, unchanged.
     */
    refreshTools(baseTools: ToolDefinition[]): void {
        if (baseTools.length === 0) {
            logger.warn('No tools discovered from probe downstream — tool list will be empty');
        }
        this._tools = baseTools;
        logger.info('Tool list refreshed', { toolCount: this._tools.length });
    }

    /**
     * Get the tool list for tools/list response (proxy, no modifications).
     */
    getTools(): ToolDefinition[] {
        return this._tools;
    }

    /**
     * Route a tools/call request to the appropriate downstream(s).
     */
    async routeCall(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
        const matchingEntries = this._entries.filter((e) =>
            matchesPattern(e.toolPattern, toolName)
        );

        if (matchingEntries.length === 0) {
            // No pattern matches — call the default downstream (plain @azure/mcp, no inject)
            logger.info('No pattern match, routing to default downstream', { tool: toolName });
            return this._downstreamManager.callDefault(toolName, args);
        }

        // All matching entries are expected to share the same injectParam
        const injectParam = matchingEntries[0]!.injectParam;
        const injectValue = args[injectParam] as string | undefined;

        if (injectValue) {
            // Route to the specific downstream matching the provided injectValue
            const normalizedValue = injectValue.trim().toLowerCase();
            const matched = matchingEntries.find(
                (e) => e.injectValue.trim().toLowerCase() === normalizedValue
            );
            if (matched) {
                logger.info('Routing by injectParam', { tool: toolName, [injectParam]: matched.injectValue });
                return this._downstreamManager.callTool(matched, toolName, args);
            }
            // Value provided but not in any configured entry — fall back to default downstream
            const available = matchingEntries.map((e) => e.injectValue).join(', ');
            logger.info('No entry matched injectParam value, falling back to default downstream', {
                tool: toolName,
                [injectParam]: injectValue,
                available,
            });
            return this._downstreamManager.callDefault(toolName, args);
        }

        if (matchingEntries.length === 1) {
            // Auto-inject the single configured value
            const entry = matchingEntries[0]!;
            logger.info('Auto-injecting single entry', { tool: toolName, [injectParam]: entry.injectValue });
            const forwardArgs = { ...args, [injectParam]: entry.injectValue };
            return this._downstreamManager.callTool(entry, toolName, forwardArgs);
        }

        // Multiple matches, no routing value — fan-out
        logger.debug('Fan-out to matching entries', { tool: toolName, count: matchingEntries.length });
        return this._fanOut(matchingEntries, toolName, args);
    }

    private async _fanOut(
        entries: RouterEntry[],
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolCallResult> {
        return this._downstreamManager.callToolOnAll(entries, toolName, args);
    }
}
