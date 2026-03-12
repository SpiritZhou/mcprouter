/**
 * Tests for router-parser utilities: parseRouterSpec, computeDownstreamKey, matchesPattern.
 */

import { describe, it, expect } from 'vitest';
import { parseRouterSpec, computeDownstreamKey, matchesPattern } from '../router-parser.js';

describe('parseRouterSpec', () => {
    // --router 'kusto_*.cluster-uri="https://mycluster.kusto.windows.net"; AZURE_CLIENT_ID="abc123"'
    // Parsed: { toolPattern:'kusto_*', injectParam:'cluster-uri',
    //           injectValue:'https://mycluster.kusto.windows.net', envOverrides:{ AZURE_CLIENT_ID:'abc123' } }
    // When tool call matches kusto_*, child process env gets AZURE_CLIENT_ID=abc123
    it('parses a spec with tool pattern, inject param, inject value, and env vars', () => {
        const entry = parseRouterSpec(
            'kusto_*.cluster-uri="https://mycluster.kusto.windows.net"; AZURE_CLIENT_ID="abc123"'
        );
        expect(entry.toolPattern).toBe('kusto_*');
        expect(entry.injectParam).toBe('cluster-uri');
        expect(entry.injectValue).toBe('https://mycluster.kusto.windows.net');
        expect(entry.envOverrides).toEqual({ AZURE_CLIENT_ID: 'abc123' });
    });

    // --router 'kusto_*.cluster-uri="https://mycluster.kusto.windows.net"'
    // Parsed: { toolPattern:'kusto_*', injectParam:'cluster-uri',
    //           injectValue:'https://mycluster.kusto.windows.net', envOverrides:{} }
    // No extra env — child process uses only globalEnv + process.env
    it('parses a spec with no env vars', () => {
        const entry = parseRouterSpec(
            'kusto_*.cluster-uri="https://mycluster.kusto.windows.net"'
        );
        expect(entry.toolPattern).toBe('kusto_*');
        expect(entry.injectParam).toBe('cluster-uri');
        expect(entry.injectValue).toBe('https://mycluster.kusto.windows.net');
        expect(entry.envOverrides).toEqual({});
    });

    // --router 'cosmos_*.account="myaccount"; AZURE_CLIENT_ID="cid"; AZURE_TENANT_ID="tid"'
    // Parsed: { toolPattern:'cosmos_*', injectParam:'account', injectValue:'myaccount',
    //           envOverrides:{ AZURE_CLIENT_ID:'cid', AZURE_TENANT_ID:'tid' } }
    // Child process env gets both AZURE_CLIENT_ID=cid and AZURE_TENANT_ID=tid
    it('parses a spec with multiple env vars', () => {
        const entry = parseRouterSpec(
            'cosmos_*.account="myaccount"; AZURE_CLIENT_ID="cid"; AZURE_TENANT_ID="tid"'
        );
        expect(entry.toolPattern).toBe('cosmos_*');
        expect(entry.injectParam).toBe('account');
        expect(entry.injectValue).toBe('myaccount');
        expect(entry.envOverrides).toEqual({ AZURE_CLIENT_ID: 'cid', AZURE_TENANT_ID: 'tid' });
    });

    // --router 'my_tool.endpoint="https://api.example.com"'
    // Parsed: { toolPattern:'my_tool', injectParam:'endpoint', injectValue:'https://api.example.com' }
    // Exact match — only tool named 'my_tool' routes to this entry
    it('parses exact tool name (no wildcard)', () => {
        const entry = parseRouterSpec('my_tool.endpoint="https://api.example.com"');
        expect(entry.toolPattern).toBe('my_tool');
        expect(entry.injectParam).toBe('endpoint');
        expect(entry.injectValue).toBe('https://api.example.com');
    });

    // --router '*.param="value"'
    // Parsed: { toolPattern:'*', injectParam:'param', injectValue:'value' }
    // All tools match — every tool call gets param='value' injected
    it('parses wildcard matching all tools', () => {
        const entry = parseRouterSpec('*.param="value"');
        expect(entry.toolPattern).toBe('*');
        expect(entry.injectParam).toBe('param');
        expect(entry.injectValue).toBe('value');
    });

    // --router 'kusto_*.cluster-uri=""'
    // Parsed: injectValue = '' (empty string) — valid but value-less entry
    it('parses empty inject value', () => {
        const entry = parseRouterSpec('kusto_*.cluster-uri=""');
        expect(entry.injectValue).toBe('');
    });

    it('throws on missing first segment', () => {
        expect(() => parseRouterSpec('')).toThrow();
    });

    it('throws on malformed first segment (no dot)', () => {
        expect(() => parseRouterSpec('kusto_cluster-uri="value"')).toThrow();
    });

    it('throws on malformed env segment', () => {
        expect(() =>
            parseRouterSpec('kusto_*.cluster-uri="val"; BADVAR')
        ).toThrow();
    });
});

describe('computeDownstreamKey', () => {
    // Key = hash(passthroughArgs + sorted env). Same args+env → same key → same child process.
    // Different env (e.g. AZURE_CLIENT_ID) → different key → separate child process.
    const env1: Record<string, string> = {
        AZURE_CLIENT_ID: 'abc123',
    };

    const env2: Record<string, string> = {
        AZURE_CLIENT_ID: 'xyz456',
    };

    const passthroughArgs = ['server', 'start', '--namespace', 'kusto'];

    it('returns a 16-char hex string', () => {
        const key = computeDownstreamKey(passthroughArgs, env1);
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    it('same inputs produce same key (stability)', () => {
        expect(computeDownstreamKey(passthroughArgs, env1)).toBe(
            computeDownstreamKey(passthroughArgs, env1)
        );
    });

    it('different env produce different keys', () => {
        expect(computeDownstreamKey(passthroughArgs, env1)).not.toBe(
            computeDownstreamKey(passthroughArgs, env2)
        );
    });

    it('different passthroughArgs produce different keys', () => {
        const otherArgs = ['server', 'start', '--namespace', 'cosmos'];
        expect(computeDownstreamKey(passthroughArgs, env1)).not.toBe(
            computeDownstreamKey(otherArgs, env1)
        );
    });

    it('env key order does not matter (sorted)', () => {
        const e1: Record<string, string> = { A: '1', B: '2' };
        const e2: Record<string, string> = { B: '2', A: '1' };
        expect(computeDownstreamKey(passthroughArgs, e1)).toBe(
            computeDownstreamKey(passthroughArgs, e2)
        );
    });

    it('empty env produces a valid key', () => {
        const key = computeDownstreamKey(passthroughArgs, {});
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('matchesPattern', () => {
    // Glob-style pattern matching: 'kusto_*' matches 'kusto_query', 'kusto_table_list', etc.
    // Used to determine which RouterEntries apply to a given tool call.
    it('matches exact tool name', () => {
        expect(matchesPattern('kusto_query', 'kusto_query')).toBe(true);
    });

    it('does not match different exact name', () => {
        expect(matchesPattern('kusto_query', 'kusto_table_list')).toBe(false);
    });

    it('matches prefix wildcard: kusto_*', () => {
        expect(matchesPattern('kusto_*', 'kusto_query')).toBe(true);
        expect(matchesPattern('kusto_*', 'kusto_table_list')).toBe(true);
        expect(matchesPattern('kusto_*', 'cosmos_query')).toBe(false);
    });

    it('matches all-wildcard: *', () => {
        expect(matchesPattern('*', 'kusto_query')).toBe(true);
        expect(matchesPattern('*', 'anything')).toBe(true);
    });

    it('handles regex-special chars in tool names safely', () => {
        // The pattern should not break on dots in the actual name
        expect(matchesPattern('kusto_*', 'kusto_cluster.get')).toBe(true);
    });

    it('does not partially match', () => {
        expect(matchesPattern('kusto_query', 'kusto_query_extra')).toBe(false);
    });
});
