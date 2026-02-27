#!/usr/bin/env node

// src/index.ts
import { Command } from "commander";

// src/downstream-manager.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// src/logger.ts
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
var LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var currentLevel = "info";
var logFilePath = null;
function setLogLevel(level) {
  currentLevel = level;
}
function enableFileLogging() {
  try {
    const scriptDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    const logsDir = join(scriptDir, "..", "logs");
    mkdirSync(logsDir, { recursive: true });
    logFilePath = join(logsDir, "mcp-router.log");
    appendFileSync(logFilePath, `
${"=".repeat(80)}
`);
    appendFileSync(logFilePath, `Router started at ${(/* @__PURE__ */ new Date()).toISOString()}
`);
    appendFileSync(logFilePath, `${"=".repeat(80)}
`);
  } catch {
    logFilePath = null;
  }
}
function shouldLog(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}
function formatMessage(level, message, context) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [mcp-router]`;
  if (context && Object.keys(context).length > 0) {
    return `${prefix} ${message} ${JSON.stringify(context)}`;
  }
  return `${prefix} ${message}`;
}
function writeLog(formatted) {
  process.stderr.write(formatted + "\n");
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, formatted + "\n");
    } catch {
    }
  }
}
var logger = {
  debug(message, context) {
    if (shouldLog("debug")) {
      writeLog(formatMessage("debug", message, context));
    }
  },
  info(message, context) {
    if (shouldLog("info")) {
      writeLog(formatMessage("info", message, context));
    }
  },
  warn(message, context) {
    if (shouldLog("warn")) {
      writeLog(formatMessage("warn", message, context));
    }
  },
  error(message, context) {
    if (shouldLog("error")) {
      writeLog(formatMessage("error", message, context));
    }
  }
};

// src/downstream-manager.ts
function normalizeClusterUrl(url) {
  let normalized = url.trim().toLowerCase();
  if (!normalized.startsWith("https://") && !normalized.startsWith("http://")) {
    normalized = `https://${normalized}`;
  }
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}
function extractClientIdFromIdentity(identity) {
  const trimmed = identity.trim();
  if (!trimmed) return null;
  return trimmed;
}
var DownstreamManager = class {
  _downstreams = /* @__PURE__ */ new Map();
  _config;
  _onDownstreamExit = null;
  constructor(config) {
    this._config = config;
  }
  /**
   * Register a callback invoked immediately when a downstream child process exits unexpectedly.
   * Used by HealthMonitor to trigger immediate reconnection instead of waiting for the next ping.
   */
  onDownstreamExit(callback) {
    this._onDownstreamExit = callback;
  }
  /**
   * Initialize all downstream connections.
   * Spawns child processes and discovers tools from each.
   */
  async initializeAll() {
    const initPromises = this._config.mappings.map(async (mapping) => {
      const key = normalizeClusterUrl(mapping.clusterUrl);
      if (this._downstreams.has(key)) {
        logger.warn(`Duplicate cluster mapping ignored`, { cluster: key });
        return;
      }
      const state = {
        mapping,
        client: null,
        transport: null,
        process: null,
        status: "Connecting",
        lastHeartbeat: null,
        consecutiveFailures: 0,
        tools: [],
        reconnecting: false
      };
      this._downstreams.set(key, state);
      try {
        await this._connectDownstream(state);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to initialize downstream for cluster`, {
          cluster: key,
          error: msg
        });
        state.status = "Failed";
      }
    });
    await Promise.allSettled(initPromises);
    const connected = [...this._downstreams.values()].filter(
      (d) => d.status === "Connected"
    ).length;
    logger.info(`Downstream initialization complete`, {
      total: this._downstreams.size,
      connected,
      failed: this._downstreams.size - connected
    });
  }
  /**
   * Spawn a child @azure/mcp process and connect to it.
   */
  async _connectDownstream(state) {
    const key = normalizeClusterUrl(state.mapping.clusterUrl);
    logger.info(`Connecting to downstream MCP`, { cluster: key });
    const args = [
      "-y",
      "@azure/mcp@latest",
      "server",
      "start",
      "--mode",
      "all",
      "--namespace",
      "kusto"
    ];
    if (this._config.readOnly) {
      args.push("--read-only");
    }
    const env = {
      ...process.env,
      AZURE_TOKEN_CREDENTIALS: process.env["AZURE_TOKEN_CREDENTIALS"] ?? "managedidentitycredential"
    };
    if (process.env["IDENTITY_ENDPOINT"]) {
      env["IDENTITY_ENDPOINT"] = process.env["IDENTITY_ENDPOINT"];
    }
    if (process.env["IDENTITY_HEADER"]) {
      env["IDENTITY_HEADER"] = process.env["IDENTITY_HEADER"];
    }
    if (state.mapping.identity) {
      const clientId = extractClientIdFromIdentity(state.mapping.identity);
      if (clientId) {
        env["AZURE_CLIENT_ID"] = clientId;
        logger.debug("Setting AZURE_CLIENT_ID for downstream", {
          cluster: key,
          clientId
        });
      }
    }
    const transport = new StdioClientTransport({
      command: "npx",
      args,
      env
    });
    const client = new Client(
      {
        name: `mcp-router-downstream-${key}`,
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
    state.client = client;
    state.transport = transport;
    state.process = transport._process ?? null;
    state.status = "Connected";
    state.lastHeartbeat = (/* @__PURE__ */ new Date()).toISOString();
    state.consecutiveFailures = 0;
    state.tools = tools;
    logger.info(`Connected to downstream MCP`, {
      cluster: key,
      toolCount: tools.length,
      tools: tools.map((t) => t.name)
    });
    if (state.process) {
      state.process.on("exit", (code, signal) => {
        logger.warn(`Downstream process exited unexpectedly`, {
          cluster: key,
          code,
          signal
        });
        state.status = "Disconnected";
        state.client = null;
        state.transport = null;
        state.process = null;
        if (this._onDownstreamExit) {
          this._onDownstreamExit(key);
        }
      });
    }
  }
  /**
   * Reconnect a failed/disconnected downstream.
   */
  async reconnect(clusterUrl) {
    const key = normalizeClusterUrl(clusterUrl);
    const state = this._downstreams.get(key);
    if (!state) {
      logger.error(`Cannot reconnect: unknown cluster`, { cluster: key });
      return false;
    }
    if (state.reconnecting) {
      logger.debug(`Already reconnecting`, { cluster: key });
      return false;
    }
    state.reconnecting = true;
    try {
      await this._cleanupDownstream(state);
      await this._connectDownstream(state);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Reconnection failed`, { cluster: key, error: msg });
      state.status = "Failed";
      return false;
    } finally {
      state.reconnecting = false;
    }
  }
  /**
   * Clean up a downstream connection (kill process, close client).
   */
  async _cleanupDownstream(state) {
    try {
      if (state.client) {
        await state.client.close();
      }
    } catch {
    }
    if (state.process && !state.process.killed) {
      state.process.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (state.process && !state.process.killed) {
            state.process.kill("SIGKILL");
          }
          resolve();
        }, 5e3);
        if (state.process) {
          state.process.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    }
    state.client = null;
    state.transport = null;
    state.process = null;
  }
  /**
   * Ping a downstream for health checking.
   */
  async ping(clusterUrl) {
    const key = normalizeClusterUrl(clusterUrl);
    const state = this._downstreams.get(key);
    if (!state || !state.client || state.status !== "Connected") {
      return false;
    }
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Ping timeout")),
          this._config.pingTimeoutSeconds * 1e3
        );
      });
      try {
        await Promise.race([state.client.ping(), timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
      state.lastHeartbeat = (/* @__PURE__ */ new Date()).toISOString();
      state.consecutiveFailures = 0;
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      state.consecutiveFailures++;
      logger.warn(`Ping failed`, {
        cluster: key,
        consecutiveFailures: state.consecutiveFailures,
        error: msg
      });
      if (state.consecutiveFailures >= 3) {
        state.status = "Disconnected";
      } else {
        state.status = "Failed";
      }
      return false;
    }
  }
  /**
   * Call a tool on a specific downstream by cluster URL.
   */
  async callTool(clusterUrl, toolName, args) {
    const key = normalizeClusterUrl(clusterUrl);
    const state = this._downstreams.get(key);
    if (!state) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown cluster "${clusterUrl}". Available clusters: ${this.getClusterUrls().join(", ")}`
          }
        ],
        isError: true
      };
    }
    if (!state.client || state.status !== "Connected") {
      return {
        content: [
          {
            type: "text",
            text: `Error: Downstream for cluster "${clusterUrl}" is not connected (status: ${state.status}). Try again later.`
          }
        ],
        isError: true
      };
    }
    try {
      const result = await state.client.callTool({
        name: toolName,
        arguments: args
      });
      return {
        content: result.content ?? [],
        isError: result.isError
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("Forbidden")) {
        logger.error(`Auth error from downstream`, {
          cluster: key,
          identity: state.mapping.identity,
          tool: toolName,
          error: msg
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `Error calling tool "${toolName}" on cluster "${clusterUrl}": ${msg}`
          }
        ],
        isError: true
      };
    }
  }
  /**
   * Call a tool on ALL downstreams (fan-out) and merge results.
   */
  async callToolOnAll(toolName, args) {
    const connectedDownstreams = [...this._downstreams.entries()].filter(
      ([, state]) => state.status === "Connected" && state.client
    );
    if (connectedDownstreams.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No downstream MCP servers are currently connected."
          }
        ],
        isError: true
      };
    }
    const results = await Promise.allSettled(
      connectedDownstreams.map(async ([clusterUrl]) => {
        return this.callTool(clusterUrl, toolName, args);
      })
    );
    const mergedContent = [];
    let hasError = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        mergedContent.push(...result.value.content);
        if (result.value.isError) {
          hasError = true;
        }
      } else {
        mergedContent.push({
          type: "text",
          text: `Error from one downstream: ${result.reason}`
        });
        hasError = true;
      }
    }
    return { content: mergedContent, isError: hasError };
  }
  /**
   * Get all configured cluster URLs.
   */
  getClusterUrls() {
    return [...this._downstreams.keys()];
  }
  /**
   * Get the connection info for all downstreams.
   */
  getConnections() {
    return [...this._downstreams.entries()].map(([clusterUrl, state]) => ({
      clusterUrl,
      identity: state.mapping.identity,
      status: state.status,
      lastHeartbeat: state.lastHeartbeat,
      consecutiveFailures: state.consecutiveFailures,
      tools: state.tools
    }));
  }
  /**
   * Get tools from the first connected downstream.
   * All downstreams expose the same tools, so we only need one set.
   */
  getToolDefinitions() {
    for (const state of this._downstreams.values()) {
      if (state.status === "Connected" && state.tools.length > 0) {
        return state.tools;
      }
    }
    return [];
  }
  /**
   * Get the status of a specific downstream.
   */
  getStatus(clusterUrl) {
    const key = normalizeClusterUrl(clusterUrl);
    return this._downstreams.get(key)?.status ?? null;
  }
  /**
   * Shut down all downstream connections gracefully.
   */
  async shutdownAll() {
    logger.info("Shutting down all downstream connections...");
    const shutdownPromises = [...this._downstreams.values()].map(
      async (state) => {
        const key = normalizeClusterUrl(state.mapping.clusterUrl);
        try {
          await this._cleanupDownstream(state);
          logger.debug(`Downstream shut down`, { cluster: key });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Error shutting down downstream`, {
            cluster: key,
            error: msg
          });
        }
      }
    );
    await Promise.allSettled(shutdownPromises);
    this._downstreams.clear();
    logger.info("All downstream connections shut down.");
  }
};

// src/tool-router.ts
var ToolRouter = class {
  _downstreamManager;
  _mergedTools = [];
  _routableTools = /* @__PURE__ */ new Set();
  _fanOutTools = /* @__PURE__ */ new Set();
  constructor(downstreamManager) {
    this._downstreamManager = downstreamManager;
  }
  /**
   * Build the merged tool list from downstream tools.
   * Dynamically classifies tools: if schema has a 'cluster' property → routable, otherwise → fan-out.
   */
  refreshTools() {
    const baseTools = this._downstreamManager.getToolDefinitions();
    if (baseTools.length === 0) {
      logger.warn("No tools discovered from any downstream \u2014 tool list will be empty");
      this._mergedTools = [];
      return;
    }
    const clusterUrls = this._downstreamManager.getClusterUrls();
    this._routableTools.clear();
    this._fanOutTools.clear();
    for (const tool of baseTools) {
      if (tool.inputSchema.properties?.["cluster"]) {
        this._routableTools.add(tool.name);
      } else {
        this._fanOutTools.add(tool.name);
      }
    }
    logger.info("Tool classification", {
      routable: [...this._routableTools],
      fanOut: [...this._fanOutTools]
    });
    this._mergedTools = baseTools.map((tool) => {
      if (this._routableTools.has(tool.name)) {
        return this._enhanceRoutableTool(tool, clusterUrls);
      }
      return this._enhanceFanOutTool(tool, clusterUrls);
    });
    logger.info(`Tool list refreshed`, {
      toolCount: this._mergedTools.length,
      tools: this._mergedTools.map((t) => t.name)
    });
  }
  /**
   * Enhance a cluster-routable tool:
   * - Mark `cluster` as required
   * - Add `enum` with available cluster URLs
   * - Update description to mention routing
   */
  _enhanceRoutableTool(tool, clusterUrls) {
    const schema = structuredClone(tool.inputSchema);
    if (!schema.properties) {
      schema.properties = {};
    }
    const existingCluster = schema.properties["cluster"];
    schema.properties["cluster"] = {
      ...existingCluster ?? {},
      type: "string",
      description: `The Kusto cluster URL to query. Must be one of the available clusters: ${clusterUrls.join(", ")}`,
      enum: clusterUrls
    };
    if (!schema.required) {
      schema.required = [];
    }
    if (!schema.required.includes("cluster")) {
      schema.required.push("cluster");
    }
    return {
      name: tool.name,
      description: tool.description ? `${tool.description} (Routed to the specified cluster)` : `Kusto tool routed to the specified cluster`,
      inputSchema: schema
    };
  }
  /**
   * Enhance a fan-out tool:
   * - Optionally add a `cluster` parameter to filter results
   * - Update description to explain fan-out behavior
   */
  _enhanceFanOutTool(tool, clusterUrls) {
    const schema = structuredClone(tool.inputSchema);
    if (!schema.properties) {
      schema.properties = {};
    }
    schema.properties["cluster"] = {
      type: "string",
      description: `Optional: specify a Kusto cluster URL to query only that cluster. If omitted, queries all clusters. Available: ${clusterUrls.join(", ")}`,
      enum: clusterUrls
    };
    return {
      name: tool.name,
      description: tool.description ? `${tool.description} (Queries all available clusters unless a specific cluster is specified)` : `Lists Kusto clusters across all available connections`,
      inputSchema: schema
    };
  }
  /**
   * Get the merged tool list for tools/list response.
   */
  getTools() {
    return this._mergedTools;
  }
  /**
   * Route a tools/call request to the appropriate downstream(s).
   */
  async routeCall(toolName, args) {
    const isRoutable = this._routableTools.has(toolName);
    const isFanOut = this._fanOutTools.has(toolName);
    if (isRoutable) {
      return this._routeToCluster(toolName, args);
    }
    if (isFanOut) {
      return this._routeFanOut(toolName, args);
    }
    logger.warn(`Unknown tool called`, { tool: toolName });
    if (args["cluster"]) {
      return this._routeToCluster(toolName, args);
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: Unknown tool "${toolName}". Available tools: ${this._mergedTools.map((t) => t.name).join(", ")}`
        }
      ],
      isError: true
    };
  }
  /**
   * Route to a specific downstream based on the `cluster` argument.
   */
  async _routeToCluster(toolName, args) {
    const cluster = args["cluster"];
    if (!cluster) {
      const clusterUrls2 = this._downstreamManager.getClusterUrls();
      return {
        content: [
          {
            type: "text",
            text: `Error: The "cluster" parameter is required for tool "${toolName}". Available clusters: ${clusterUrls2.join(", ")}`
          }
        ],
        isError: true
      };
    }
    const normalizedCluster = normalizeClusterUrl(cluster);
    const clusterUrls = this._downstreamManager.getClusterUrls();
    const matchedCluster = clusterUrls.find((url) => url === normalizedCluster);
    if (!matchedCluster) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Cluster "${cluster}" is not configured. Available clusters: ${clusterUrls.join(", ")}`
          }
        ],
        isError: true
      };
    }
    logger.debug(`Routing tool call`, {
      tool: toolName,
      cluster: matchedCluster
    });
    return this._downstreamManager.callTool(matchedCluster, toolName, args);
  }
  /**
   * Fan-out: call all downstreams (or a single one if cluster is specified).
   */
  async _routeFanOut(toolName, args) {
    const cluster = args["cluster"];
    if (cluster) {
      const normalizedCluster = normalizeClusterUrl(cluster);
      const clusterUrls = this._downstreamManager.getClusterUrls();
      const matchedCluster = clusterUrls.find((url) => url === normalizedCluster);
      if (!matchedCluster) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Cluster "${cluster}" is not configured. Available clusters: ${clusterUrls.join(", ")}`
            }
          ],
          isError: true
        };
      }
      const forwardArgs2 = { ...args };
      delete forwardArgs2["cluster"];
      return this._downstreamManager.callTool(matchedCluster, toolName, forwardArgs2);
    }
    logger.debug(`Fan-out tool call to all downstreams`, { tool: toolName });
    const forwardArgs = { ...args };
    delete forwardArgs["cluster"];
    return this._downstreamManager.callToolOnAll(toolName, forwardArgs);
  }
};

// src/health-monitor.ts
var HealthMonitor = class {
  _downstreamManager;
  _config;
  _interval = null;
  _reconnectBackoffs = /* @__PURE__ */ new Map();
  _reconnectTimers = /* @__PURE__ */ new Map();
  _running = false;
  constructor(downstreamManager, config) {
    this._downstreamManager = downstreamManager;
    this._config = config;
    this._downstreamManager.onDownstreamExit((clusterUrl) => {
      if (this._running) {
        logger.info("Downstream process exited, scheduling immediate reconnection", {
          cluster: clusterUrl
        });
        this._scheduleReconnect(clusterUrl);
      }
    });
  }
  /**
   * Start the health monitor.
   */
  start() {
    if (this._running) {
      logger.warn("Health monitor already running");
      return;
    }
    this._running = true;
    const intervalMs = this._config.pingIntervalSeconds * 1e3;
    logger.info("Health monitor started", {
      pingIntervalSeconds: this._config.pingIntervalSeconds,
      pingTimeoutSeconds: this._config.pingTimeoutSeconds,
      maxReconnectBackoffSeconds: this._config.maxReconnectBackoffSeconds
    });
    this._interval = setInterval(() => {
      void this._checkAll();
    }, intervalMs);
    if (this._interval.unref) {
      this._interval.unref();
    }
  }
  /**
   * Stop the health monitor.
   */
  stop() {
    if (!this._running) {
      return;
    }
    this._running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    for (const [, timer] of this._reconnectTimers) {
      clearTimeout(timer);
    }
    this._reconnectTimers.clear();
    this._reconnectBackoffs.clear();
    logger.info("Health monitor stopped");
  }
  /**
   * Check all downstreams health and trigger reconnection if needed.
   */
  async _checkAll() {
    const connections = this._downstreamManager.getConnections();
    for (const connection of connections) {
      if (connection.status === "Connected") {
        const ok = await this._downstreamManager.ping(connection.clusterUrl);
        if (!ok) {
          logger.warn("Health check failed, scheduling reconnection", {
            cluster: connection.clusterUrl
          });
          this._scheduleReconnect(connection.clusterUrl);
        } else {
          this._reconnectBackoffs.delete(connection.clusterUrl);
        }
      } else if (connection.status === "Failed" || connection.status === "Disconnected") {
        if (!this._reconnectTimers.has(connection.clusterUrl)) {
          this._scheduleReconnect(connection.clusterUrl);
        }
      }
    }
  }
  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  _scheduleReconnect(clusterUrl) {
    if (this._reconnectTimers.has(clusterUrl)) {
      return;
    }
    const currentBackoff = this._reconnectBackoffs.get(clusterUrl) ?? 1;
    const backoffMs = currentBackoff * 1e3;
    logger.info("Scheduling reconnection", {
      cluster: clusterUrl,
      backoffSeconds: currentBackoff
    });
    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(clusterUrl);
      if (!this._running) {
        return;
      }
      logger.info("Attempting reconnection", { cluster: clusterUrl });
      const success = await this._downstreamManager.reconnect(clusterUrl);
      if (success) {
        logger.info("Reconnection successful", { cluster: clusterUrl });
        this._reconnectBackoffs.delete(clusterUrl);
      } else {
        const nextBackoff = Math.min(
          currentBackoff * 2,
          this._config.maxReconnectBackoffSeconds
        );
        this._reconnectBackoffs.set(clusterUrl, nextBackoff);
        logger.warn("Reconnection failed, will retry", {
          cluster: clusterUrl,
          nextBackoffSeconds: nextBackoff
        });
        if (this._running) {
          this._scheduleReconnect(clusterUrl);
        }
      }
    }, backoffMs);
    if (timer.unref) {
      timer.unref();
    }
    this._reconnectTimers.set(clusterUrl, timer);
  }
  /**
   * Whether the health monitor is currently running.
   */
  get isRunning() {
    return this._running;
  }
};

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
async function createAndStartServer(toolRouter) {
  const server = new McpServer(
    {
      name: "mcp-router",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );
  const tools = toolRouter.getTools();
  for (const tool of tools) {
    registerTool(server, tool, toolRouter);
  }
  logger.info(`MCP server created`, { registeredTools: tools.length });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected via stdio transport");
  return { server, transport };
}
function buildZodSchema(inputSchema) {
  const zodProps = {};
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
function jsonSchemaPropertyToZod(prop) {
  const description = prop.description;
  switch (prop.type) {
    case "string": {
      let schema;
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        schema = z.enum(prop.enum);
      } else {
        schema = z.string();
      }
      return description ? schema.describe(description) : schema;
    }
    case "number":
    case "integer": {
      const schema = z.number();
      return description ? schema.describe(description) : schema;
    }
    case "boolean": {
      const schema = z.boolean();
      return description ? schema.describe(description) : schema;
    }
    case "array": {
      const itemSchema = prop.items ? jsonSchemaPropertyToZod(prop.items) : z.unknown();
      const schema = z.array(itemSchema);
      return description ? schema.describe(description) : schema;
    }
    default: {
      const schema = z.unknown();
      return description ? schema.describe(description) : schema;
    }
  }
}
function registerTool(server, tool, toolRouter) {
  const zodSchema = buildZodSchema(tool.inputSchema);
  server.tool(
    tool.name,
    tool.description ?? `Tool: ${tool.name}`,
    zodSchema,
    async (args) => {
      logger.debug(`Tool call received`, {
        tool: tool.name,
        args: Object.keys(args)
      });
      const result = await toolRouter.routeCall(
        tool.name,
        args
      );
      return {
        content: result.content.map((c) => ({
          type: c.type,
          text: c.text ?? ""
        })),
        isError: result.isError
      };
    }
  );
  logger.debug(`Registered tool`, { tool: tool.name });
}

// src/lifecycle.ts
var shutdownInProgress = false;
function registerShutdownHandlers(components) {
  const shutdown = async (signal) => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      components.healthMonitor.stop();
      try {
        await components.transport.close();
      } catch {
      }
      await components.downstreamManager.shutdownAll();
      logger.info("Graceful shutdown complete");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Error during shutdown", { error: msg });
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => {
    logger.info("stdin closed (parent disconnected)");
    void shutdown("stdin-close");
  });
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", {
      error: error.message,
      stack: error.stack
    });
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error("Unhandled rejection", { error: msg });
  });
}

// src/index.ts
function parseMapping(value, previous) {
  const eqIndex = value.indexOf("=");
  let clusterUrl;
  let identity;
  if (eqIndex === -1) {
    clusterUrl = value;
    identity = "";
  } else {
    clusterUrl = value.substring(0, eqIndex);
    identity = value.substring(eqIndex + 1);
  }
  if (!clusterUrl) {
    throw new Error(`Invalid mapping: "${value}". Expected format: clusterUrl=identity or clusterUrl`);
  }
  previous.push({ clusterUrl, identity });
  return previous;
}
async function main() {
  const program = new Command();
  program.name("mcp-router").description(
    "MCP server that routes tool calls to multiple downstream @azure/mcp instances"
  ).version("1.0.0").requiredOption(
    "--mapping <mapping>",
    'Cluster-to-identity mapping in format "clusterUrl=identity". Can be specified multiple times for multiple clusters. If identity is omitted, uses the default managed identity.',
    parseMapping,
    []
  ).option("--read-only", "Run downstream MCPs in read-only mode", true).option("--no-read-only", "Allow write operations on downstream MCPs").option(
    "--ping-interval <seconds>",
    "Health check ping interval in seconds",
    "60"
  ).option(
    "--ping-timeout <seconds>",
    "Health check ping timeout in seconds",
    "10"
  ).option(
    "--max-reconnect-backoff <seconds>",
    "Maximum reconnection backoff in seconds",
    "300"
  ).option(
    "--log-level <level>",
    "Log level (debug, info, warn, error)",
    "info"
  ).parse(process.argv);
  const opts = program.opts();
  const mappings = opts.mapping;
  if (mappings.length === 0) {
    logger.error(
      "No cluster mappings provided. Use --mapping to specify at least one cluster."
    );
    process.exit(1);
  }
  const config = {
    mappings,
    readOnly: opts.readOnly,
    pingIntervalSeconds: parseInt(opts.pingInterval, 10),
    pingTimeoutSeconds: parseInt(opts.pingTimeout, 10),
    maxReconnectBackoffSeconds: parseInt(opts.maxReconnectBackoff, 10),
    logLevel: opts.logLevel
  };
  setLogLevel(config.logLevel);
  enableFileLogging();
  logger.info("Starting MCP Router", {
    clusters: config.mappings.map((m) => m.clusterUrl),
    readOnly: config.readOnly,
    pingIntervalSeconds: config.pingIntervalSeconds
  });
  const downstreamManager = new DownstreamManager(config);
  await downstreamManager.initializeAll();
  const connectedCount = downstreamManager.getConnections().filter((c) => c.status === "Connected").length;
  if (connectedCount === 0) {
    logger.error(
      "No downstream MCP servers could be connected. Exiting."
    );
    await downstreamManager.shutdownAll();
    process.exit(1);
  }
  const toolRouter = new ToolRouter(downstreamManager);
  toolRouter.refreshTools();
  const tools = toolRouter.getTools();
  if (tools.length === 0) {
    logger.error("No tools discovered from any downstream. Exiting.");
    await downstreamManager.shutdownAll();
    process.exit(1);
  }
  const { server, transport } = await createAndStartServer(toolRouter);
  const healthMonitor = new HealthMonitor(downstreamManager, config);
  healthMonitor.start();
  registerShutdownHandlers({
    downstreamManager,
    healthMonitor,
    server,
    transport
  });
  logger.info("MCP Router is ready", {
    clusters: downstreamManager.getClusterUrls(),
    tools: tools.map((t) => t.name),
    connectedDownstreams: connectedCount
  });
}
main().catch((error) => {
  logger.error("Fatal error during startup", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : void 0
  });
  process.exit(1);
});
