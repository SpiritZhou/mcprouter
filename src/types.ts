/**
 * Types for the generic MCP Router.
 */

/**
 * A single routing entry parsed from one --router flag.
 * Defines which tools to route, which parameter to use, the value for this target,
 * and any environment overrides for the spawned child process.
 *
 * Parsed from the format:
 *   toolPattern.injectParam="injectValue"; ENV_KEY="envValue"; ...
 *
 * Example:
 *   kusto_*.cluster_uri="https://mycluster.kusto.windows.net"; AZURE_CLIENT_ID="abc123"
 */
export interface RouterEntry {
    /** Glob pattern matching tool names, e.g. "kusto_*" or "cosmos_*" */
    toolPattern: string;
    /** Parameter name injected/matched for routing, e.g. "cluster_uri" */
    injectParam: string;
    /** The value associated with this routing target, e.g. "https://mycluster.kusto.windows.net" */
    injectValue: string;
    /**
     * Per-entry environment variable overrides applied to this downstream's child process.
     * Layered on top of globalEnv. Typically used for per-identity vars like AZURE_CLIENT_ID.
     */
    envOverrides: Record<string, string>;
}

/**
 * Connection status for a downstream MCP server.
 */
export type ConnectionStatus = 'Connected' | 'Connecting' | 'Failed' | 'Disconnected';

/**
 * Represents a downstream @azure/mcp server instance (public view).
 */
export interface DownstreamConnection {
    /** Hash-based key uniquely identifying this downstream */
    key: string;
    /** Human-readable spec: "injectParam=injectValue" */
    entrySpec: string;
    /** Current connection status */
    status: ConnectionStatus;
    /** ISO 8601 timestamp of last successful heartbeat */
    lastHeartbeat: string | null;
    /** Consecutive ping failures */
    consecutiveFailures: number;
    /** Tools discovered from this downstream */
    tools: ToolDefinition[];
}

/**
 * MCP tool definition as returned by tools/list.
 */
export interface ToolDefinition {
    name: string;
    description?: string;
    inputSchema: ToolInputSchema;
}

/**
 * JSON Schema for tool input parameters.
 */
export interface ToolInputSchema {
    type: 'object';
    properties?: Record<string, PropertySchema>;
    required?: string[];
    additionalProperties?: boolean;
}

/**
 * JSON Schema property definition.
 */
export interface PropertySchema {
    type?: string;
    description?: string;
    enum?: string[];
    default?: unknown;
    items?: PropertySchema;
    [key: string]: unknown;
}

/**
 * Result of a tools/call invocation.
 */
export interface ToolCallResult {
    content: ToolContent[];
    isError?: boolean;
}

/**
 * Content item in a tool call result.
 */
export interface ToolContent {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
}



/**
 * CLI configuration parsed from command-line arguments.
 */
export interface RouterConfig {
    /** Parsed --router entries, one per routing target */
    entries: RouterEntry[];
    /**
     * Arguments forwarded verbatim to each child @azure/mcp process.
     * E.g. ["server", "start", "--namespace", "kusto", "--mode", "all", "--read-only"]
     */
    passthroughArgs: string[];
    /**
     * Environment variables from --env KEY=VALUE, applied to ALL child processes.
     * Applied before per-entry envOverrides.
     */
    globalEnv: Record<string, string>;
    /**
     * Version specifier for the @azure/mcp npm package used when spawning child processes.
     * E.g. "latest", "1.2.3". Defaults to "latest".
     */
    mcpVersion: string;
    /** Log level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
