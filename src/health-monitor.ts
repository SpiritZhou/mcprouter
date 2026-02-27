/**
 * HealthMonitor — periodically pings all downstream MCP servers and
 * triggers reconnection for failed/disconnected ones.
 *
 * Features:
 * - Configurable ping interval
 * - Consecutive failure tracking (3 failures → Disconnected)
 * - Exponential backoff for reconnection (up to maxReconnectBackoffSeconds)
 * - Logs health status changes
 */

import type { DownstreamManager } from './downstream-manager.js';
import type { RouterConfig } from './types.js';
import { logger } from './logger.js';

export class HealthMonitor {
    private readonly _downstreamManager: DownstreamManager;
    private readonly _config: RouterConfig;
    private _interval: ReturnType<typeof setInterval> | null = null;
    private readonly _reconnectBackoffs = new Map<string, number>();
    private readonly _reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private _running = false;

    constructor(downstreamManager: DownstreamManager, config: RouterConfig) {
        this._downstreamManager = downstreamManager;
        this._config = config;

        // Register for immediate notification when a downstream process exits
        this._downstreamManager.onDownstreamExit((clusterUrl) => {
            if (this._running) {
                logger.info('Downstream process exited, scheduling immediate reconnection', {
                    cluster: clusterUrl,
                });
                this._scheduleReconnect(clusterUrl);
            }
        });
    }

    /**
     * Start the health monitor.
     */
    start(): void {
        if (this._running) {
            logger.warn('Health monitor already running');
            return;
        }

        this._running = true;
        const intervalMs = this._config.pingIntervalSeconds * 1000;

        logger.info('Health monitor started', {
            pingIntervalSeconds: this._config.pingIntervalSeconds,
            pingTimeoutSeconds: this._config.pingTimeoutSeconds,
            maxReconnectBackoffSeconds: this._config.maxReconnectBackoffSeconds,
        });

        this._interval = setInterval(() => {
            void this._checkAll();
        }, intervalMs);

        // Don't prevent process exit
        if (this._interval.unref) {
            this._interval.unref();
        }
    }

    /**
     * Stop the health monitor.
     */
    stop(): void {
        if (!this._running) {
            return;
        }

        this._running = false;

        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }

        // Clear all reconnection timers
        for (const [, timer] of this._reconnectTimers) {
            clearTimeout(timer);
        }
        this._reconnectTimers.clear();
        this._reconnectBackoffs.clear();

        logger.info('Health monitor stopped');
    }

    /**
     * Check all downstreams health and trigger reconnection if needed.
     */
    private async _checkAll(): Promise<void> {
        const connections = this._downstreamManager.getConnections();

        for (const connection of connections) {
            if (connection.status === 'Connected') {
                // Ping connected downstreams
                const ok = await this._downstreamManager.ping(connection.clusterUrl);

                if (!ok) {
                    logger.warn('Health check failed, scheduling reconnection', {
                        cluster: connection.clusterUrl,
                    });
                    this._scheduleReconnect(connection.clusterUrl);
                } else {
                    // Reset backoff on successful ping
                    this._reconnectBackoffs.delete(connection.clusterUrl);
                }
            } else if (
                connection.status === 'Failed' ||
                connection.status === 'Disconnected'
            ) {
                // Already unhealthy — schedule reconnection if not already scheduled
                if (!this._reconnectTimers.has(connection.clusterUrl)) {
                    this._scheduleReconnect(connection.clusterUrl);
                }
            }
        }
    }

    /**
     * Schedule a reconnection attempt with exponential backoff.
     */
    private _scheduleReconnect(clusterUrl: string): void {
        if (this._reconnectTimers.has(clusterUrl)) {
            return; // Already scheduled
        }

        const currentBackoff = this._reconnectBackoffs.get(clusterUrl) ?? 1;
        const backoffMs = currentBackoff * 1000;

        logger.info('Scheduling reconnection', {
            cluster: clusterUrl,
            backoffSeconds: currentBackoff,
        });

        const timer = setTimeout(async () => {
            this._reconnectTimers.delete(clusterUrl);

            if (!this._running) {
                return;
            }

            logger.info('Attempting reconnection', { cluster: clusterUrl });
            const success = await this._downstreamManager.reconnect(clusterUrl);

            if (success) {
                logger.info('Reconnection successful', { cluster: clusterUrl });
                this._reconnectBackoffs.delete(clusterUrl);
            } else {
                // Increase backoff with exponential growth, capped at max
                const nextBackoff = Math.min(
                    currentBackoff * 2,
                    this._config.maxReconnectBackoffSeconds
                );
                this._reconnectBackoffs.set(clusterUrl, nextBackoff);
                logger.warn('Reconnection failed, will retry', {
                    cluster: clusterUrl,
                    nextBackoffSeconds: nextBackoff,
                });

                // Schedule next attempt
                if (this._running) {
                    this._scheduleReconnect(clusterUrl);
                }
            }
        }, backoffMs);

        // Don't prevent process exit
        if (timer.unref) {
            timer.unref();
        }

        this._reconnectTimers.set(clusterUrl, timer);
    }

    /**
     * Whether the health monitor is currently running.
     */
    get isRunning(): boolean {
        return this._running;
    }
}
