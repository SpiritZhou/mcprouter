/**
 * Lifecycle management — handles graceful shutdown on SIGINT, SIGTERM,
 * and stdin close events.
 *
 * Ensures:
 * 1. MCP server transport is closed
 * 2. All downstream child processes are terminated (SIGTERM, then SIGKILL after 1s)
 * 3. Process exits cleanly
 */

import type { DownstreamManager } from './downstream-manager.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';

interface LifecycleComponents {
    downstreamManager: DownstreamManager;
    server: Server;
    transport: StdioServerTransport;
}

let shutdownInProgress = false;

/**
 * Register signal and stdin handlers for graceful shutdown.
 */
export function registerShutdownHandlers(components: LifecycleComponents): void {
    const shutdown = async (signal: string, force: boolean): Promise<void> => {
        if (shutdownInProgress) {
            return;
        }
        shutdownInProgress = true;

        logger.info(`Received ${signal}, shutting down${force ? ' (forced)' : ''}...`);

        try {
            // 1. Close MCP server transport
            try {
                await components.transport.close();
            } catch {
                // Ignore — transport may already be closed
            }

            // 2. Shut down all downstream connections
            await components.downstreamManager.shutdownAll(force);

            logger.info('Shutdown complete');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('Error during shutdown', { error: msg });
        }

        process.exit(0);
    };

    // Signal handlers — SIGTERM/SIGINT get graceful shutdown
    process.on('SIGINT', () => void shutdown('SIGINT', false));
    process.on('SIGTERM', () => void shutdown('SIGTERM', false));

    // stdin close — the parent process (Session.Proxy) closed the pipe,
    // which typically means it's about to SIGKILL the entire process tree.
    // Use forced shutdown (SIGKILL children immediately) to avoid racing
    // with the parent's kill.
    process.stdin.on('close', () => {
        logger.info('stdin closed (parent disconnected)');
        void shutdown('stdin-close', true);
    });

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception', {
            error: error.message,
            stack: error.stack,
        });
        void shutdown('uncaughtException', false);
    });

    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        logger.error('Unhandled rejection', { error: msg });
        // Don't shut down — just log. The health monitor will handle downstream failures.
    });
}
