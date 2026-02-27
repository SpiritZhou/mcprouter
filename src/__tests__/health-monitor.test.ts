/**
 * Tests for HealthMonitor — ping intervals, failure tracking, reconnection scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthMonitor } from '../health-monitor.js';
import type { DownstreamManager } from '../downstream-manager.js';
import type { DownstreamConnection, RouterConfig } from '../types.js';

function createMockDownstreamManager(connections: DownstreamConnection[]): DownstreamManager {
    return {
        getConnections: vi.fn(() => connections),
        ping: vi.fn(async () => true),
        reconnect: vi.fn(async () => true),
        getClusterUrls: vi.fn(() => connections.map((c) => c.clusterUrl)),
        shutdownAll: vi.fn(async () => {}),
        onDownstreamExit: vi.fn(),
    } as unknown as DownstreamManager;
}

const DEFAULT_CONFIG: RouterConfig = {
    mappings: [],
    readOnly: true,
    pingIntervalSeconds: 1, // 1 second for tests
    pingTimeoutSeconds: 5,
    maxReconnectBackoffSeconds: 10,
    logLevel: 'error', // Suppress logs in tests
};

describe('HealthMonitor', () => {
    let monitor: HealthMonitor;
    let mockManager: DownstreamManager;

    afterEach(() => {
        if (monitor) {
            monitor.stop();
        }
    });

    describe('start/stop', () => {
        beforeEach(() => {
            mockManager = createMockDownstreamManager([]);
            monitor = new HealthMonitor(mockManager, DEFAULT_CONFIG);
        });

        it('starts and reports running', () => {
            monitor.start();
            expect(monitor.isRunning).toBe(true);
        });

        it('stops and reports not running', () => {
            monitor.start();
            monitor.stop();
            expect(monitor.isRunning).toBe(false);
        });

        it('handles double start gracefully', () => {
            monitor.start();
            monitor.start(); // Should not throw
            expect(monitor.isRunning).toBe(true);
        });

        it('handles double stop gracefully', () => {
            monitor.start();
            monitor.stop();
            monitor.stop(); // Should not throw
            expect(monitor.isRunning).toBe(false);
        });
    });

    describe('health checks', () => {
        it('pings connected downstreams', async () => {
            const connections: DownstreamConnection[] = [
                {
                    clusterUrl: 'https://cluster1.kusto.windows.net',
                    identity: 'id1',
                    status: 'Connected',
                    lastHeartbeat: new Date().toISOString(),
                    consecutiveFailures: 0,
                    tools: [],
                },
            ];

            mockManager = createMockDownstreamManager(connections);
            monitor = new HealthMonitor(mockManager, DEFAULT_CONFIG);

            monitor.start();

            // Wait for at least one ping cycle
            await new Promise((resolve) => setTimeout(resolve, 1500));

            expect(mockManager.ping).toHaveBeenCalledWith(
                'https://cluster1.kusto.windows.net'
            );
        });

        it('schedules reconnection for failed downstreams', async () => {
            const connections: DownstreamConnection[] = [
                {
                    clusterUrl: 'https://cluster1.kusto.windows.net',
                    identity: 'id1',
                    status: 'Failed',
                    lastHeartbeat: null,
                    consecutiveFailures: 2,
                    tools: [],
                },
            ];

            mockManager = createMockDownstreamManager(connections);
            monitor = new HealthMonitor(mockManager, DEFAULT_CONFIG);

            monitor.start();

            // Wait for reconnection attempt
            await new Promise((resolve) => setTimeout(resolve, 2500));

            expect(mockManager.reconnect).toHaveBeenCalledWith(
                'https://cluster1.kusto.windows.net'
            );
        });
    });
});
