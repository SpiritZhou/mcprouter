/**
 * Types for the generic MCP Router.
 */

/**
 * Configuration for a group of downstream MCP servers sharing the same namespace.
 * Each group defines how to spawn child processes and which property to use for routing.
 */
export interface DownstreamGroupConfig {
    /** @azure/mcp namespace (e.g. "kusto", "cosmos") */
    namespace: string;
    /** The tool schema property name used for routing (e.g. "cluster", "account") */
    routingKey: string;
    /**
     * When forwarding the routing key value to the downstream, use this property name instead.
     * Useful when the downstream expects a different parameter name than the one exposed in the schema.
     * E.g., routing on "account" but forwarding as "accountName".
     * Defaults to the same as routingKey if not specified.
     */
    forwardKeyAs?: string;
    /** @azure/mcp --mode value (default: "all") */
    mode?: string;
    /** Whether downstream MCPs in this group should run in read-only mode */
    readOnly?: boolean;
    /** Downstream instances in this group */
    downstreams: DownstreamMapping[];
}

/**
 * A mapping from a routing key value to an identity resource ID.
 * The key is an opaque identifier (URL, name, region:account, etc.) that matches
 * the routing key property value in tool calls.
 */
export interface DownstreamMapping {
    /** Opaque routing key value, e.g. "https://mycluster.kusto.windows.net", "eastus:myaccount" */
    key: string;
    /** UAMI resource ID, client ID, or empty string if using default identity */
    identity: string;
}

/**
 * Connection status for a downstream MCP server.
 */
export type ConnectionStatus = 'Connected' | 'Connecting' | 'Failed' | 'Disconnected';

/**
 * Represents a downstream @azure/mcp server instance.
 */
export interface DownstreamConnection {
    /** Normalized downstream key (opaque routing value) */
    key: string;
    /** Group namespace this downstream belongs to */
    group: string;
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
 * CLI configuration parsed from command-line arguments or config file.
 */
export interface RouterConfig {
    /** Downstream groups — each group defines a namespace, routing key, and downstream instances */
    groups: DownstreamGroupConfig[];
    /** Health check ping interval in seconds */
    pingIntervalSeconds: number;
    /** Health check ping timeout in seconds */
    pingTimeoutSeconds: number;
    /** Max reconnection backoff in seconds */
    maxReconnectBackoffSeconds: number;
    /** Log level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
