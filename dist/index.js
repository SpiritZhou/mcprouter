#!/usr/bin/env node

// src/index.ts
import { readFileSync } from "fs";
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
function normalizeKey(key) {
  return key.trim().toLowerCase();
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
   * Initialize all downstream connections across all groups.
   * Spawns child processes and discovers tools from each.
   */
  async initializeAll() {
    const initPromises = [];
    for (const group of this._config.groups) {
      for (const mapping of group.downstreams) {
        const normalizedKey = normalizeKey(mapping.key);
        if (this._downstreams.has(normalizedKey)) {
          logger.warn(`Duplicate downstream mapping ignored`, { key: normalizedKey });
          continue;
        }
        const state = {
          mapping,
          group,
          client: null,
          transport: null,
          process: null,
          status: "Connecting",
          lastHeartbeat: null,
          consecutiveFailures: 0,
          tools: [],
          reconnecting: false
        };
        this._downstreams.set(normalizedKey, state);
        initPromises.push(
          (async () => {
            try {
              await this._connectDownstream(state);
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              logger.error(`Failed to initialize downstream`, {
                key: normalizedKey,
                group: group.namespace,
                error: msg
              });
              state.status = "Failed";
            }
          })()
        );
      }
    }
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
   * Uses the group config for namespace, mode, and readOnly settings.
   */
  async _connectDownstream(state) {
    const normalizedKey = normalizeKey(state.mapping.key);
    const { group } = state;
    logger.info(`Connecting to downstream MCP`, {
      key: normalizedKey,
      namespace: group.namespace
    });
    const args = [
      "-y",
      "@azure/mcp@latest",
      "server",
      "start",
      "--mode",
      group.mode ?? "all",
      "--namespace",
      group.namespace
    ];
    if (group.readOnly !== false) {
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
          key: normalizedKey,
          clientId
        });
      }
    }
    logger.info("Spawning downstream MCP process", {
      key: normalizedKey,
      command: "npx",
      args,
      env: {
        AZURE_TOKEN_CREDENTIALS: env["AZURE_TOKEN_CREDENTIALS"] ?? "(not set)",
        AZURE_CLIENT_ID: env["AZURE_CLIENT_ID"] ?? "(not set)",
        IDENTITY_ENDPOINT: env["IDENTITY_ENDPOINT"] ? "(set)" : "(not set)",
        IDENTITY_HEADER: env["IDENTITY_HEADER"] ? "(set)" : "(not set)"
      }
    });
    const transport = new StdioClientTransport({
      command: "npx",
      args,
      env
    });
    const client = new Client(
      {
        name: `mcp-router-downstream-${normalizedKey}`,
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
      key: normalizedKey,
      namespace: group.namespace,
      toolCount: tools.length,
      tools: tools.map((t) => t.name)
    });
    if (state.process) {
      state.process.on("exit", (code, signal) => {
        logger.warn(`Downstream process exited unexpectedly`, {
          key: normalizedKey,
          code,
          signal
        });
        state.status = "Disconnected";
        state.client = null;
        state.transport = null;
        state.process = null;
        if (this._onDownstreamExit) {
          this._onDownstreamExit(normalizedKey);
        }
      });
    }
  }
  /**
   * Reconnect a failed/disconnected downstream.
   */
  async reconnect(key) {
    const normalizedKey = normalizeKey(key);
    const state = this._downstreams.get(normalizedKey);
    if (!state) {
      logger.error(`Cannot reconnect: unknown downstream`, { key: normalizedKey });
      return false;
    }
    if (state.reconnecting) {
      logger.debug(`Already reconnecting`, { key: normalizedKey });
      return false;
    }
    state.reconnecting = true;
    try {
      await this._cleanupDownstream(state);
      await this._connectDownstream(state);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Reconnection failed`, { key: normalizedKey, error: msg });
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
  async ping(key) {
    const normalizedKey = normalizeKey(key);
    const state = this._downstreams.get(normalizedKey);
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
        key: normalizedKey,
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
   * Call a tool on a specific downstream by key.
   */
  async callTool(key, toolName, args) {
    const normalizedKey = normalizeKey(key);
    const state = this._downstreams.get(normalizedKey);
    if (!state) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown downstream "${key}". Available: ${this.getDownstreamKeys().join(", ")}`
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
            text: `Error: Downstream "${key}" is not connected (status: ${state.status}). Try again later.`
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
          key: normalizedKey,
          identity: state.mapping.identity,
          tool: toolName,
          error: msg
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `Error calling tool "${toolName}" on "${key}": ${msg}`
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
      connectedDownstreams.map(async ([key]) => {
        return this.callTool(key, toolName, args);
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
   * Get all configured downstream keys.
   */
  getDownstreamKeys() {
    return [...this._downstreams.keys()];
  }
  /**
   * Get the routing key property name. All groups must use the same routing key
   * for the current single-router model; returns the first group's routing key.
   */
  getRoutingKey() {
    if (this._config.groups.length > 0) {
      return this._config.groups[0].routingKey;
    }
    return "cluster-uri";
  }
  /**
   * Get the forwardKeyAs property name. When forwarding the routing key value
   * to the downstream, use this name instead of the routing key.
   *
   * Returns the routing key if no override is configured.
   */
  getForwardKeyAs() {
    if (this._config.groups.length > 0) {
      const group = this._config.groups[0];
      if (group.forwardKeyAs) {
        return group.forwardKeyAs;
      }
      return group.routingKey;
    }
    return this.getRoutingKey();
  }
  /**
   * Get the connection info for all downstreams.
   */
  getConnections() {
    return [...this._downstreams.entries()].map(([key, state]) => ({
      key,
      group: state.group.namespace,
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
  getStatus(key) {
    const normalizedKey = normalizeKey(key);
    return this._downstreams.get(normalizedKey)?.status ?? null;
  }
  /**
   * Shut down all downstream connections gracefully.
   */
  async shutdownAll() {
    logger.info("Shutting down all downstream connections...");
    const shutdownPromises = [...this._downstreams.values()].map(
      async (state) => {
        const normalizedKey = normalizeKey(state.mapping.key);
        try {
          await this._cleanupDownstream(state);
          logger.debug(`Downstream shut down`, { key: normalizedKey });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Error shutting down downstream`, {
            key: normalizedKey,
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
  _routingKey;
  _forwardKeyAs;
  constructor(downstreamManager) {
    this._downstreamManager = downstreamManager;
    this._routingKey = downstreamManager.getRoutingKey();
    this._forwardKeyAs = downstreamManager.getForwardKeyAs();
    logger.info("ToolRouter initialized", {
      routingKey: this._routingKey,
      forwardKeyAs: this._forwardKeyAs,
      areEqual: this._routingKey === this._forwardKeyAs
    });
  }
  /**
   * Build the merged tool list from downstream tools.
   * Dynamically classifies tools: if schema has the routing key property → routable, otherwise → fan-out.
   */
  refreshTools() {
    this._routingKey = this._downstreamManager.getRoutingKey();
    this._forwardKeyAs = this._downstreamManager.getForwardKeyAs();
    const baseTools = this._downstreamManager.getToolDefinitions();
    if (baseTools.length === 0) {
      logger.warn("No tools discovered from any downstream \u2014 tool list will be empty");
      this._mergedTools = [];
      return;
    }
    const downstreamKeys = this._downstreamManager.getDownstreamKeys();
    this._routableTools.clear();
    this._fanOutTools.clear();
    for (const tool of baseTools) {
      if (tool.inputSchema.properties?.[this._routingKey]) {
        this._routableTools.add(tool.name);
      } else {
        this._fanOutTools.add(tool.name);
      }
    }
    logger.info("Tool classification", {
      routingKey: this._routingKey,
      routable: [...this._routableTools],
      fanOut: [...this._fanOutTools]
    });
    this._mergedTools = baseTools.map((tool) => {
      if (this._routableTools.has(tool.name)) {
        return this._enhanceRoutableTool(tool, downstreamKeys);
      }
      return this._enhanceFanOutTool(tool, downstreamKeys);
    });
    logger.info(`Tool list refreshed`, {
      toolCount: this._mergedTools.length,
      tools: this._mergedTools.map((t) => t.name)
    });
  }
  /**
   * Enhance a routable tool:
   * - Mark the routing key as required
   * - Add `enum` with available downstream keys
   * - Update description to mention routing
   */
  _enhanceRoutableTool(tool, downstreamKeys) {
    const schema = structuredClone(tool.inputSchema);
    if (!schema.properties) {
      schema.properties = {};
    }
    const existingProp = schema.properties[this._routingKey];
    schema.properties[this._routingKey] = {
      ...existingProp ?? {},
      type: "string",
      description: `The ${this._routingKey} to route to. Must be one of: ${downstreamKeys.join(", ")}`,
      enum: downstreamKeys
    };
    if (!schema.required) {
      schema.required = [];
    }
    if (!schema.required.includes(this._routingKey)) {
      schema.required.push(this._routingKey);
    }
    return {
      name: tool.name,
      description: tool.description ? `${tool.description} (Routed to the specified ${this._routingKey})` : `Tool routed to the specified ${this._routingKey}`,
      inputSchema: schema
    };
  }
  /**
   * Enhance a fan-out tool:
   * - Optionally add the routing key parameter to filter results
   * - Update description to explain fan-out behavior
   */
  _enhanceFanOutTool(tool, downstreamKeys) {
    const schema = structuredClone(tool.inputSchema);
    if (!schema.properties) {
      schema.properties = {};
    }
    schema.properties[this._routingKey] = {
      type: "string",
      description: `Optional: specify a ${this._routingKey} to target only that downstream. If omitted, queries all. Available: ${downstreamKeys.join(", ")}`,
      enum: downstreamKeys
    };
    return {
      name: tool.name,
      description: tool.description ? `${tool.description} (Queries all available downstreams unless a specific ${this._routingKey} is specified)` : `Queries all available downstreams`,
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
      return this._routeToDownstream(toolName, args);
    }
    if (isFanOut) {
      return this._routeFanOut(toolName, args);
    }
    logger.warn(`Unknown tool called`, { tool: toolName });
    if (args[this._routingKey]) {
      return this._routeToDownstream(toolName, args);
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
   * Route to a specific downstream based on the routing key argument.
   */
  async _routeToDownstream(toolName, args) {
    const routingValue = args[this._routingKey];
    if (!routingValue) {
      const downstreamKeys2 = this._downstreamManager.getDownstreamKeys();
      return {
        content: [
          {
            type: "text",
            text: `Error: The "${this._routingKey}" parameter is required for tool "${toolName}". Available: ${downstreamKeys2.join(", ")}`
          }
        ],
        isError: true
      };
    }
    const normalizedValue = normalizeKey(routingValue);
    const downstreamKeys = this._downstreamManager.getDownstreamKeys();
    const matched = downstreamKeys.find((k) => k === normalizedValue);
    if (!matched) {
      return {
        content: [
          {
            type: "text",
            text: `Error: "${routingValue}" is not configured. Available: ${downstreamKeys.join(", ")}`
          }
        ],
        isError: true
      };
    }
    logger.debug(`Routing tool call`, {
      tool: toolName,
      [this._routingKey]: matched
    });
    const forwardArgs = this._transformRoutingKey(args);
    logger.info("Forwarding routable tool call to downstream", {
      tool: toolName,
      routingKey: this._routingKey,
      forwardKeyAs: this._forwardKeyAs,
      originalArgs: Object.keys(args),
      forwardedArgs: Object.keys(forwardArgs),
      forwardedArgsValues: forwardArgs
    });
    return this._downstreamManager.callTool(matched, toolName, forwardArgs);
  }
  /**
   * Fan-out: call all downstreams (or a single one if routing key is specified).
   */
  async _routeFanOut(toolName, args) {
    const routingValue = args[this._routingKey];
    if (routingValue) {
      const normalizedValue = normalizeKey(routingValue);
      const downstreamKeys = this._downstreamManager.getDownstreamKeys();
      const matched = downstreamKeys.find((k) => k === normalizedValue);
      if (!matched) {
        return {
          content: [
            {
              type: "text",
              text: `Error: "${routingValue}" is not configured. Available: ${downstreamKeys.join(", ")}`
            }
          ],
          isError: true
        };
      }
      const forwardArgs2 = { ...args };
      delete forwardArgs2[this._routingKey];
      return this._downstreamManager.callTool(matched, toolName, forwardArgs2);
    }
    logger.debug(`Fan-out tool call to all downstreams`, { tool: toolName });
    const forwardArgs = { ...args };
    delete forwardArgs[this._routingKey];
    return this._downstreamManager.callToolOnAll(toolName, forwardArgs);
  }
  /**
   * Transform the routing key in args for downstream forwarding.
   * If forwardKeyAs differs from routingKey, rename the property.
   * E.g., routing on "account" but forwarding as "accountName".
   */
  _transformRoutingKey(args) {
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
    this._downstreamManager.onDownstreamExit((key) => {
      if (this._running) {
        logger.info("Downstream process exited, scheduling immediate reconnection", {
          key
        });
        this._scheduleReconnect(key);
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
        const ok = await this._downstreamManager.ping(connection.key);
        if (!ok) {
          logger.warn("Health check failed, scheduling reconnection", {
            key: connection.key
          });
          this._scheduleReconnect(connection.key);
        } else {
          this._reconnectBackoffs.delete(connection.key);
        }
      } else if (connection.status === "Failed" || connection.status === "Disconnected") {
        if (!this._reconnectTimers.has(connection.key)) {
          this._scheduleReconnect(connection.key);
        }
      }
    }
  }
  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  _scheduleReconnect(key) {
    if (this._reconnectTimers.has(key)) {
      return;
    }
    const currentBackoff = this._reconnectBackoffs.get(key) ?? 1;
    const backoffMs = currentBackoff * 1e3;
    logger.info("Scheduling reconnection", {
      key,
      backoffSeconds: currentBackoff
    });
    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(key);
      if (!this._running) {
        return;
      }
      logger.info("Attempting reconnection", { key });
      const success = await this._downstreamManager.reconnect(key);
      if (success) {
        logger.info("Reconnection successful", { key });
        this._reconnectBackoffs.delete(key);
      } else {
        const nextBackoff = Math.min(
          currentBackoff * 2,
          this._config.maxReconnectBackoffSeconds
        );
        this._reconnectBackoffs.set(key, nextBackoff);
        logger.warn("Reconnection failed, will retry", {
          key,
          nextBackoffSeconds: nextBackoff
        });
        if (this._running) {
          this._scheduleReconnect(key);
        }
      }
    }, backoffMs);
    if (timer.unref) {
      timer.unref();
    }
    this._reconnectTimers.set(key, timer);
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
  let key;
  let identity;
  if (eqIndex === -1) {
    key = value;
    identity = "";
  } else {
    key = value.substring(0, eqIndex);
    identity = value.substring(eqIndex + 1);
  }
  if (!key) {
    throw new Error(`Invalid mapping: "${value}". Expected format: key=identity or key`);
  }
  previous.push({ key, identity });
  return previous;
}
function loadConfigFile(configPath) {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.groups || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    throw new Error('Config file must contain a non-empty "groups" array.');
  }
  for (const group of parsed.groups) {
    if (!group.namespace) {
      throw new Error('Each group must have a "namespace" field.');
    }
    if (!group.routingKey) {
      throw new Error(`Group "${group.namespace}" must have a "routingKey" field.`);
    }
    if (!group.downstreams || !Array.isArray(group.downstreams) || group.downstreams.length === 0) {
      throw new Error(`Group "${group.namespace}" must have a non-empty "downstreams" array.`);
    }
    for (const ds of group.downstreams) {
      if (!ds.key) {
        throw new Error(`Each downstream in group "${group.namespace}" must have a "key" field.`);
      }
      if (ds.identity === void 0) {
        ds.identity = "";
      }
    }
  }
  return {
    groups: parsed.groups,
    pingIntervalSeconds: parsed.pingIntervalSeconds ?? 60,
    pingTimeoutSeconds: parsed.pingTimeoutSeconds ?? 10,
    maxReconnectBackoffSeconds: parsed.maxReconnectBackoffSeconds ?? 300,
    logLevel: parsed.logLevel ?? "info"
  };
}
async function main() {
  const program = new Command();
  program.name("mcp-router").description(
    "Generic MCP server that routes tool calls to multiple downstream @azure/mcp instances"
  ).version("1.0.0").option(
    "--config <path>",
    "Path to a JSON config file defining downstream groups"
  ).option(
    "--namespace <namespace>",
    '@azure/mcp namespace for CLI mode (e.g. "kusto", "cosmos")',
    "kusto"
  ).option(
    "--routing-key <key>",
    'Tool schema property name used for routing (e.g. "cluster-uri", "account")',
    "cluster-uri"
  ).option(
    "--forward-key-as <key>",
    "Rename the routing key when forwarding to the downstream. E.g., --routing-key account --forward-key-as accountName"
  ).option(
    "--mapping <mapping>",
    'Downstream mapping in format "key=identity" (CLI mode). Can be specified multiple times. If identity is omitted, uses the default managed identity.',
    parseMapping,
    []
  ).option(
    "--mode <mode>",
    "@azure/mcp --mode value (CLI mode)",
    "all"
  ).option("--read-only", "Run downstream MCPs in read-only mode (CLI mode)", true).option("--no-read-only", "Allow write operations on downstream MCPs").option(
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
  let config;
  if (opts.config) {
    try {
      config = loadConfigFile(opts.config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load config file: ${msg}`);
      process.exit(1);
    }
    if (opts.logLevel !== "info") {
      config.logLevel = opts.logLevel;
    }
  } else {
    const mappings = opts.mapping;
    if (mappings.length === 0) {
      logger.error(
        "No downstream mappings provided. Use --mapping or --config."
      );
      process.exit(1);
    }
    const group = {
      namespace: opts.namespace,
      routingKey: opts.routingKey,
      forwardKeyAs: opts.forwardKeyAs,
      mode: opts.mode,
      readOnly: opts.readOnly,
      downstreams: mappings
    };
    config = {
      groups: [group],
      pingIntervalSeconds: parseInt(opts.pingInterval, 10),
      pingTimeoutSeconds: parseInt(opts.pingTimeout, 10),
      maxReconnectBackoffSeconds: parseInt(opts.maxReconnectBackoff, 10),
      logLevel: opts.logLevel
    };
  }
  setLogLevel(config.logLevel);
  enableFileLogging();
  logger.info("Starting MCP Router", {
    groups: config.groups.map((g) => ({
      namespace: g.namespace,
      routingKey: g.routingKey,
      downstreams: g.downstreams.map((d) => d.key)
    })),
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
    downstreams: downstreamManager.getDownstreamKeys(),
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
export {
  parseMapping
};
