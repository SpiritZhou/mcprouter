#!/usr/bin/env node
/**
 * A mapping from a routing key value to an identity resource ID.
 * The key is an opaque identifier (URL, name, region:account, etc.) that matches
 * the routing key property value in tool calls.
 */
interface DownstreamMapping {
    /** Opaque routing key value, e.g. "https://mycluster.kusto.windows.net", "eastus:myaccount" */
    key: string;
    /** UAMI resource ID, client ID, or empty string if using default identity */
    identity: string;
}

/**
 * @sreagent/mcp-router
 *
 * Generic MCP server that routes tool calls to multiple downstream @azure/mcp
 * instances. Each downstream is spawned as a child process running
 * `npx -y @azure/mcp@latest server start --namespace <ns>`.
 *
 * Supports two modes:
 * 1. CLI flags (single group):
 *    mcp-router --namespace kusto --routing-key cluster \
 *      --mapping https://cluster1=identity1
 *
 * 2. Config file (multiple groups):
 *    mcp-router --config router-config.json
 *
 * The server communicates over stdio (stdin/stdout) using the MCP protocol.
 * Logs are written to stderr.
 */

/**
 * Parse a --mapping value: "key=identity" or "key" (no identity).
 */
declare function parseMapping(value: string, previous: DownstreamMapping[]): DownstreamMapping[];

export { parseMapping };
