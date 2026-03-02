#!/usr/bin/env node

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

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { DownstreamManager } from './downstream-manager.js';
import { ToolRouter } from './tool-router.js';
import { HealthMonitor } from './health-monitor.js';
import { createAndStartServer } from './server.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { logger, setLogLevel, enableFileLogging } from './logger.js';
import type { DownstreamMapping, DownstreamGroupConfig, RouterConfig } from './types.js';

/**
 * Parse a --mapping value: "key=identity" or "key" (no identity).
 */
export function parseMapping(value: string, previous: DownstreamMapping[]): DownstreamMapping[] {
    const eqIndex = value.indexOf('=');
    let key: string;
    let identity: string;

    if (eqIndex === -1) {
        // No identity — use default
        key = value;
        identity = '';
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

/**
 * Load and validate a config file.
 */
function loadConfigFile(configPath: string): RouterConfig {
    const raw = readFileSync(configPath, 'utf-8');
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
            if (ds.identity === undefined) {
                ds.identity = '';
            }
        }
    }

    return {
        groups: parsed.groups as DownstreamGroupConfig[],
        pingIntervalSeconds: parsed.pingIntervalSeconds ?? 60,
        pingTimeoutSeconds: parsed.pingTimeoutSeconds ?? 10,
        maxReconnectBackoffSeconds: parsed.maxReconnectBackoffSeconds ?? 300,
        logLevel: parsed.logLevel ?? 'info',
    };
}

async function main(): Promise<void> {
    const program = new Command();

    program
        .name('mcp-router')
        .description(
            'Generic MCP server that routes tool calls to multiple downstream @azure/mcp instances'
        )
        .version('1.0.0')
        .option(
            '--config <path>',
            'Path to a JSON config file defining downstream groups'
        )
        .option(
            '--namespace <namespace>',
            '@azure/mcp namespace for CLI mode (e.g. "kusto", "cosmos")',
            'kusto'
        )
        .option(
            '--routing-key <key>',
            'Tool schema property name used for routing (e.g. "cluster-uri", "account")',
            'cluster-uri'
        )
        .option(
            '--forward-key-as <key>',
            'Rename the routing key when forwarding to the downstream. ' +
            'E.g., --routing-key account --forward-key-as accountName'
        )
        .option(
            '--mapping <mapping>',
            'Downstream mapping in format "key=identity" (CLI mode). ' +
            'Can be specified multiple times. ' +
            'If identity is omitted, uses the default managed identity.',
            parseMapping,
            [] as DownstreamMapping[]
        )
        .option(
            '--mode <mode>',
            '@azure/mcp --mode value (CLI mode)',
            'all'
        )
        .option('--read-only', 'Run downstream MCPs in read-only mode (CLI mode)', true)
        .option('--no-read-only', 'Allow write operations on downstream MCPs')
        .option(
            '--ping-interval <seconds>',
            'Health check ping interval in seconds',
            '60'
        )
        .option(
            '--ping-timeout <seconds>',
            'Health check ping timeout in seconds',
            '10'
        )
        .option(
            '--max-reconnect-backoff <seconds>',
            'Maximum reconnection backoff in seconds',
            '300'
        )
        .option(
            '--log-level <level>',
            'Log level (debug, info, warn, error)',
            'info'
        )
        .parse(process.argv);

    const opts = program.opts();

    let config: RouterConfig;

    if (opts.config) {
        // Config file mode — load from JSON
        try {
            config = loadConfigFile(opts.config as string);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to load config file: ${msg}`);
            process.exit(1);
        }

        // CLI overrides for log level and health settings
        if (opts.logLevel !== 'info') {
            config.logLevel = opts.logLevel as RouterConfig['logLevel'];
        }
    } else {
        // CLI flags mode — build a single group from flags
        const mappings = opts.mapping as DownstreamMapping[];

        if (mappings.length === 0) {
            logger.error(
                'No downstream mappings provided. Use --mapping or --config.'
            );
            process.exit(1);
        }

        const group: DownstreamGroupConfig = {
            namespace: opts.namespace as string,
            routingKey: opts.routingKey as string,
            forwardKeyAs: opts.forwardKeyAs as string | undefined,
            mode: opts.mode as string,
            readOnly: opts.readOnly as boolean,
            downstreams: mappings,
        };

        config = {
            groups: [group],
            pingIntervalSeconds: parseInt(opts.pingInterval as string, 10),
            pingTimeoutSeconds: parseInt(opts.pingTimeout as string, 10),
            maxReconnectBackoffSeconds: parseInt(opts.maxReconnectBackoff as string, 10),
            logLevel: opts.logLevel as RouterConfig['logLevel'],
        };
    }

    setLogLevel(config.logLevel);
    enableFileLogging();

    logger.info('Starting MCP Router', {
        groups: config.groups.map((g) => ({
            namespace: g.namespace,
            routingKey: g.routingKey,
            downstreams: g.downstreams.map((d) => d.key),
        })),
        pingIntervalSeconds: config.pingIntervalSeconds,
    });

    // 1. Initialize all downstream @azure/mcp instances
    const downstreamManager = new DownstreamManager(config);
    await downstreamManager.initializeAll();

    const connectedCount = downstreamManager
        .getConnections()
        .filter((c) => c.status === 'Connected').length;

    if (connectedCount === 0) {
        logger.error(
            'No downstream MCP servers could be connected. Exiting.'
        );
        await downstreamManager.shutdownAll();
        process.exit(1);
    }

    // 2. Build the merged tool list
    const toolRouter = new ToolRouter(downstreamManager);
    toolRouter.refreshTools();

    const tools = toolRouter.getTools();
    if (tools.length === 0) {
        logger.error('No tools discovered from any downstream. Exiting.');
        await downstreamManager.shutdownAll();
        process.exit(1);
    }

    // 3. Start the MCP server over stdio
    const { server, transport } = await createAndStartServer(toolRouter);

    // 4. Start health monitoring
    const healthMonitor = new HealthMonitor(downstreamManager, config);
    healthMonitor.start();

    // 5. Register shutdown handlers
    registerShutdownHandlers({
        downstreamManager,
        healthMonitor,
        server,
        transport,
    });

    logger.info('MCP Router is ready', {
        downstreams: downstreamManager.getDownstreamKeys(),
        tools: tools.map((t) => t.name),
        connectedDownstreams: connectedCount,
    });
}

main().catch((error) => {
    logger.error('Fatal error during startup', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
});
