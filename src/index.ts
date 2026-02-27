#!/usr/bin/env node

/**
 * @sreagent/mcp-router
 *
 * MCP server that routes tool calls to multiple downstream @azure/mcp
 * instances based on endpoint URL. Each downstream is spawned as a child process
 * running `npx -y @azure/mcp@latest server start --namespace <ns>`.
 *
 * Usage:
 *   npx @sreagent/mcp-router \
 *     --mapping https://endpoint1=/sub/.../id1 \
 *     --mapping https://endpoint2=/sub/.../id2
 *
 * The server communicates over stdio (stdin/stdout) using the MCP protocol.
 * Logs are written to stderr.
 */

import { Command } from 'commander';
import { DownstreamManager } from './downstream-manager.js';
import { ToolRouter } from './tool-router.js';
import { HealthMonitor } from './health-monitor.js';
import { createAndStartServer } from './server.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { logger, setLogLevel, enableFileLogging } from './logger.js';
import type { ClusterMapping, RouterConfig } from './types.js';

/**
 * Parse a --mapping value: "clusterUrl=identityResourceId" or "clusterUrl" (no identity).
 */
function parseMapping(value: string, previous: ClusterMapping[]): ClusterMapping[] {
    const eqIndex = value.indexOf('=');
    let clusterUrl: string;
    let identity: string;

    if (eqIndex === -1) {
        // No identity — use default
        clusterUrl = value;
        identity = '';
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

async function main(): Promise<void> {
    const program = new Command();

    program
        .name('mcp-router')
        .description(
            'MCP server that routes tool calls to multiple downstream @azure/mcp instances'
        )
        .version('1.0.0')
        .requiredOption(
            '--mapping <mapping>',
            'Cluster-to-identity mapping in format "clusterUrl=identity". ' +
            'Can be specified multiple times for multiple clusters. ' +
            'If identity is omitted, uses the default managed identity.',
            parseMapping,
            [] as ClusterMapping[]
        )
        .option('--read-only', 'Run downstream MCPs in read-only mode', true)
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
    const mappings = opts.mapping as ClusterMapping[];

    if (mappings.length === 0) {
        logger.error(
            'No cluster mappings provided. Use --mapping to specify at least one cluster.'
        );
        process.exit(1);
    }

    const config: RouterConfig = {
        mappings,
        readOnly: opts.readOnly as boolean,
        pingIntervalSeconds: parseInt(opts.pingInterval as string, 10),
        pingTimeoutSeconds: parseInt(opts.pingTimeout as string, 10),
        maxReconnectBackoffSeconds: parseInt(opts.maxReconnectBackoff as string, 10),
        logLevel: opts.logLevel as RouterConfig['logLevel'],
    };

    setLogLevel(config.logLevel);
    enableFileLogging();

    logger.info('Starting MCP Router', {
        clusters: config.mappings.map((m) => m.clusterUrl),
        readOnly: config.readOnly,
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
        clusters: downstreamManager.getClusterUrls(),
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
