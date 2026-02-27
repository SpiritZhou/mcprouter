/**
 * Lifecycle management — handles graceful shutdown on SIGINT, SIGTERM,
 * and stdin close events.
 *
 * Ensures:
 * 1. Health monitor is stopped
 * 2. MCP server transport is closed
 * 3. All downstream child processes are terminated (SIGTERM, then SIGKILL after 5s)
 * 4. Process exits cleanly
 */

import type { DownstreamManager } from './downstream-manager.js';
import type { HealthMonitor } from './health-monitor.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';

interface LifecycleComponents {
    downstreamManager: DownstreamManager;
    healthMonitor: HealthMonitor;
    server: McpServer;
    transport: StdioServerTransport;
}

let shutdownInProgress = false;

/**
 * Register signal and stdin handlers for graceful shutdown.
 */
export function registerShutdownHandlers(components: LifecycleComponents): void {
    const shutdown = async (signal: string): Promise<void> => {
        if (shutdownInProgress) {
            return;
        }
        shutdownInProgress = true;

        logger.info(`Received ${signal}, shutting down gracefully...`);

        try {
            // 1. Stop health monitor
            components.healthMonitor.stop();

            // 2. Close MCP server transport
            try {
                await components.transport.close();
            } catch {
                // Ignore — transport may already be closed
            }

            // 3. Shut down all downstream connections
            await components.downstreamManager.shutdownAll();

            logger.info('Graceful shutdown complete');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Error during shutdown', { error: msg });
        }

        process.exit(0);
    };

    // Signal handlers
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // stdin close — the parent process (Session.Proxy) closed the pipe
    process.stdin.on('close', () => {
        logger.info('stdin closed (parent disconnected)');
        void shutdown('stdin-close');
    });

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception', {
            error: error.message,
            stack: error.stack,
        });
        void shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        logger.error('Unhandled rejection', { error: msg });
        // Don't shut down — just log. The health monitor will handle downstream failures.
    });
}
