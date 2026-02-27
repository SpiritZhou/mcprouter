/**
 * Types for the Kusto MCP Router.
 */

/**
 * A mapping from a Kusto cluster URL to an identity resource ID.
 */
export interface ClusterMapping {
    /** Kusto cluster URL, e.g. "https://mycluster.kusto.windows.net" */
    clusterUrl: string;
    /** UAMI resource ID or empty string if using default identity */
    identity: string;
}

/**
 * Connection status for a downstream MCP server.
 */
export type ConnectionStatus = 'Connected' | 'Connecting' | 'Failed' | 'Disconnected';

/**
 * Represents a downstream @azure/mcp Kusto MCP server instance.
 */
export interface DownstreamConnection {
    /** Normalized cluster URL */
    clusterUrl: string;
    /** Identity resource ID */
    identity: string;
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
    /** Cluster-to-identity mappings */
    mappings: ClusterMapping[];
    /** Whether downstream Kusto MCPs should run in read-only mode */
    readOnly: boolean;
    /** Health check ping interval in seconds */
    pingIntervalSeconds: number;
    /** Health check ping timeout in seconds */
    pingTimeoutSeconds: number;
    /** Max reconnection backoff in seconds */
    maxReconnectBackoffSeconds: number;
    /** Log level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
