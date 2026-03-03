#!/usr/bin/env node

/**
 * @sreagent/mcp-router
 *
 * Generic MCP server that routes tool calls to multiple downstream @azure/mcp
 * instances. All child process arguments are forwarded verbatim via --args
 * (one token per flag), making any future @azure/mcp CLI changes transparent.
 *
 * Usage:
 *   mcp-router \
 *     --args server --args start --args --namespace --args kusto \
 *     --env AZURE_TENANT_ID=abc123 \
 *     --router 'kusto_*.cluster_uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="id1"' \
 *     --router 'kusto_*.cluster_uri="https://cluster2.kusto.windows.net"; AZURE_CLIENT_ID="id2"'
 *
 * --router spec format:
 *   toolPattern.injectParam="injectValue"[; ENV_KEY="envValue"]...
 */

import { Command } from 'commander';
import { DownstreamManager } from './downstream-manager.js';
import { ToolRouter } from './tool-router.js';

import { createAndStartServer } from './server.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { logger, setLogLevel, enableFileLogging } from './logger.js';
import { parseRouterSpec } from './router-parser.js';
import type { RouterEntry, RouterConfig } from './types.js';

/**
 * Collect --env KEY=VALUE values into a Record.
 */
function collectEnv(value: string, previous: Record<string, string>): Record<string, string> {
    const eqIdx = value.indexOf('=');
    if (eqIdx < 1) {
        logger.error(`Invalid --env value: "${value}". Expected format: KEY=VALUE`);
        process.exit(1);
    }
    const key = value.slice(0, eqIdx);
    const val = value.slice(eqIdx + 1);
    return { ...previous, [key]: val };
}

/**
 * Collect --router values into an array (used as commander's collect callback).
 */
function collectRouter(value: string, previous: RouterEntry[]): RouterEntry[] {
    try {
        previous.push(parseRouterSpec(value));
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Invalid --router spec: ${msg}`);
        process.exit(1);
    }
    return previous;
}

/**
 * Collect --args tokens into a string array (one raw token per flag).
 */
function collectPassthroughArg(value: string, previous: string[]): string[] {
    previous.push(value);
    return previous;
}

async function main(): Promise<void> {
    const program = new Command();

    program
        .name('mcp-router')
        .description(
            'Generic MCP server that routes tool calls to multiple downstream @azure/mcp instances. ' +
            'Drop-in replacement for @azure/mcp with multi-target routing via --router.'
        )
        .version('1.0.0')
        // ── Passthrough args ───────────────────────────────────────────────────
        .option(
            '--args <token>',
            'A single argument token forwarded verbatim to each child @azure/mcp process. ' +
            'Repeatable — one flag per token. ' +
            'Example: --args server --args start --args --namespace --args kusto',
            collectPassthroughArg,
            [] as string[]
        )
        // ── Router-specific args ───────────────────────────────────────────────
        .option(
            '--env <KEY=VALUE>',
            'Environment variable applied to ALL child MCP processes. Repeatable. ' +
            'Example: --env AZURE_TENANT_ID=abc123',
            collectEnv,
            {} as Record<string, string>
        )
        .option(
            '--router <spec>',
            'Routing target spec: toolPattern.injectParam="value"[; ENV_KEY="val"]. ' +
            'Repeatable — one per routing target. Example: kusto_*.cluster_uri="https://cluster1.kusto.windows.net"; AZURE_CLIENT_ID="abc123"',
            collectRouter,
            [] as RouterEntry[]
        )
        // ── Meta options ───────────────────────────────────────────────────────
        .option(
            '--mcp-version <version>',
            'Version of @azure/mcp to use when spawning child processes (e.g. "latest", "1.2.3"). Defaults to "latest".',
            'latest'
        )
        .option(
            '--log-level <level>',
            'Log level (debug, info, warn, error)',
            'info'
        )
        .parse(process.argv);

    const opts = program.opts();

    const entries = opts.router as RouterEntry[];

    if (entries.length === 0) {
        logger.error(
            'No routing targets provided. Use --router to specify at least one routing target. ' +
            'Example: --router kusto_*.cluster_uri="https://mycluster.kusto.windows.net"; AZURE_CLIENT_ID="abc"'
        );
        process.exit(1);
    }

    const logLevel = opts.logLevel as RouterConfig['logLevel'];
    setLogLevel(logLevel);
    enableFileLogging();

    const passthroughArgs = opts.args as string[];

    const mcpVersion = (opts.mcpVersion as string) || 'latest';

    const config: RouterConfig = {
        entries,
        passthroughArgs,
        globalEnv: opts.env as Record<string, string>,
        mcpVersion,
        logLevel,
    };

    logger.info('Starting MCP Router', {
        passthroughArgs,
        routerEntries: entries.map((e) => ({
            toolPattern: e.toolPattern,
            injectParam: e.injectParam,
            injectValue: e.injectValue,
            envOverrideKeys: Object.keys(e.envOverrides),
        })),
    });

    // 1. Probe tool schemas from the first entry downstream (eager for schema discovery)
    const downstreamManager = new DownstreamManager(config);
    const baseTools = await downstreamManager.probeToolSchemas();

    if (baseTools.length === 0) {
        logger.error('No tools discovered from probe downstream. Exiting.');
        await downstreamManager.shutdownAll();
        process.exit(1);
    }

    // 2. Build the merged tool list
    const toolRouter = new ToolRouter(downstreamManager, entries);
    toolRouter.refreshTools(baseTools);

    const tools = toolRouter.getTools();
    if (tools.length === 0) {
        logger.error('No tools in merged list. Exiting.');
        await downstreamManager.shutdownAll();
        process.exit(1);
    }

    // 3. Start the MCP server over stdio
    const { server, transport } = await createAndStartServer(toolRouter);

    // 4. Register shutdown handlers
    registerShutdownHandlers({
        downstreamManager,
        server,
        transport,
    });

    logger.info('MCP Router is ready', {
        tools: tools.map((t) => t.name),
        routerEntries: entries.length,
    });
}

main().catch((error) => {
    logger.error('Fatal error during startup', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
});
