/**
 * Tests for DownstreamManager — verifies child process spawning uses all --args tokens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture StdioClientTransport constructor args
const transportConstructorCalls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: class MockStdioClientTransport {
        constructor(opts: { command: string; args: string[]; env: Record<string, string> }) {
            transportConstructorCalls.push({ command: opts.command, args: opts.args, env: opts.env });
        }
    },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class MockClient {
        connect = vi.fn().mockResolvedValue(undefined);
        listTools = vi.fn().mockResolvedValue({
            tools: [
                {
                    name: 'test_tool',
                    description: 'A test tool',
                    inputSchema: { type: 'object', properties: {} },
                },
            ],
        });
        close = vi.fn().mockResolvedValue(undefined);
    },
}));

import { DownstreamManager } from '../downstream-manager.js';
import type { RouterConfig } from '../types.js';

describe('DownstreamManager', () => {
    beforeEach(() => {
        transportConstructorCalls.length = 0;
    });

    describe('child process spawning', () => {
        // Config: passthroughArgs=['npx','-y','@azure/mcp@latest','server','start','--namespace','kusto'], globalEnv={}, entries=[]
        // Child process spawned: command='npx', args=['-y','@azure/mcp@latest','server','start','--namespace','kusto']
        // Effective child command line: npx -y @azure/mcp@latest server start --namespace kusto
        // Env: { ...process.env, AZURE_TOKEN_CREDENTIALS: 'managedidentitycredential' }
        it('uses first --args token as command and remaining tokens as args', async () => {
            const config: RouterConfig = {
                entries: [],
                passthroughArgs: ['npx', '-y', '@azure/mcp@latest', 'server', 'start', '--namespace', 'kusto'],
                globalEnv: {},
                logLevel: 'error',
            };

            const manager = new DownstreamManager(config);
            await manager.probeToolSchemas();

            expect(transportConstructorCalls).toHaveLength(1);
            const call = transportConstructorCalls[0]!;
            expect(call.command).toBe('npx');
            expect(call.args).toEqual(['-y', '@azure/mcp@latest', 'server', 'start', '--namespace', 'kusto']);
        });

        // Config: passthroughArgs=['my-mcp-server'], globalEnv={}, entries=[]
        // Child process spawned: command='my-mcp-server', args=[]
        // Effective child command line: my-mcp-server
        // Env: { ...process.env, AZURE_TOKEN_CREDENTIALS: 'managedidentitycredential' }
        it('passes a single-token --args as command with no args', async () => {
            const config: RouterConfig = {
                entries: [],
                passthroughArgs: ['my-mcp-server'],
                globalEnv: {},
                logLevel: 'error',
            };

            const manager = new DownstreamManager(config);
            await manager.probeToolSchemas();

            expect(transportConstructorCalls).toHaveLength(1);
            const call = transportConstructorCalls[0]!;
            expect(call.command).toBe('my-mcp-server');
            expect(call.args).toEqual([]);
        });

        // Config: passthroughArgs=[], globalEnv={}, entries=[]
        // No child process spawned — no command token available, fails gracefully
        // Expected: transportConstructorCalls.length === 0, returns empty tools
        it('throws when passthroughArgs is empty (no command)', async () => {
            const config: RouterConfig = {
                entries: [],
                passthroughArgs: [],
                globalEnv: {},
                logLevel: 'error',
            };

            const manager = new DownstreamManager(config);
            const tools = await manager.probeToolSchemas();
            // Should fail gracefully — no transport created
            expect(transportConstructorCalls).toHaveLength(0);
            expect(tools).toEqual([]);
        });

        // Config: passthroughArgs=['my-server','--start'],
        //         globalEnv={ TEST_OVERRIDE_KEY:'from-env-flag', GLOBAL_ONLY:'global-val' },
        //         entries[0].envOverrides={ ROUTER_KEY:'from-router' }
        // process.env.TEST_OVERRIDE_KEY = 'from-process-env' (set in test)
        // Child process spawned: command='my-server', args=['--start']
        // Effective child command line: my-server --start
        // Env priority: --env (lowest) → process.env (middle) → --router ENV_KEY (highest)
        //   TEST_OVERRIDE_KEY = 'from-process-env' (process.env overrides --env 'from-env-flag')
        //   ROUTER_KEY = 'from-router' (--router overrides all)
        //   GLOBAL_ONLY = 'global-val' (from --env, may be overridden by process.env if set)
        it('applies env override priority: --env < process.env < --router ENV_KEY', async () => {
            // Set a process.env value that should override --env
            const originalVal = process.env['TEST_OVERRIDE_KEY'];
            process.env['TEST_OVERRIDE_KEY'] = 'from-process-env';

            try {
                const config: RouterConfig = {
                    entries: [
                        {
                            toolPattern: 'test_*',
                            injectParam: 'endpoint',
                            injectValue: 'https://example.com',
                            envOverrides: { ROUTER_KEY: 'from-router' },
                        },
                    ],
                    passthroughArgs: ['my-server', '--start'],
                    globalEnv: { TEST_OVERRIDE_KEY: 'from-env-flag', GLOBAL_ONLY: 'global-val' },
                    logLevel: 'error',
                };

                const manager = new DownstreamManager(config);
                await manager.probeToolSchemas();

                expect(transportConstructorCalls).toHaveLength(1);
                const env = transportConstructorCalls[0]!.env;

                // --env value overridden by process.env
                expect(env['TEST_OVERRIDE_KEY']).toBe('from-process-env');
                // --router ENV_KEY has highest priority
                expect(env['ROUTER_KEY']).toBe('from-router');
            } finally {
                if (originalVal === undefined) {
                    delete process.env['TEST_OVERRIDE_KEY'];
                } else {
                    process.env['TEST_OVERRIDE_KEY'] = originalVal;
                }
            }
        });
    });
});
