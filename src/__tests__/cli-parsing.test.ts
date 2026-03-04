/**
 * Tests for router-parser utilities: parseRouterSpec, computeDownstreamKey, matchesPattern.
 */

import { describe, it, expect } from 'vitest';
import { parseRouterSpec, computeDownstreamKey, matchesPattern } from '../router-parser.js';

describe('parseRouterSpec', () => {
    it('parses a spec with tool pattern, inject param, inject value, and env vars', () => {
        const entry = parseRouterSpec(
            'kusto_*.cluster_uri="https://mycluster.kusto.windows.net"; AZURE_CLIENT_ID="abc123"'
        );
        expect(entry.toolPattern).toBe('kusto_*');
        expect(entry.injectParam).toBe('cluster_uri');
        expect(entry.injectValue).toBe('https://mycluster.kusto.windows.net');
        expect(entry.envOverrides).toEqual({ AZURE_CLIENT_ID: 'abc123' });
    });

    it('parses a spec with no env vars', () => {
        const entry = parseRouterSpec(
            'kusto_*.cluster_uri="https://mycluster.kusto.windows.net"'
        );
        expect(entry.toolPattern).toBe('kusto_*');
        expect(entry.injectParam).toBe('cluster_uri');
        expect(entry.injectValue).toBe('https://mycluster.kusto.windows.net');
        expect(entry.envOverrides).toEqual({});
    });

    it('parses a spec with multiple env vars', () => {
        const entry = parseRouterSpec(
            'cosmos_*.account="myaccount"; AZURE_CLIENT_ID="cid"; AZURE_TENANT_ID="tid"'
        );
        expect(entry.toolPattern).toBe('cosmos_*');
        expect(entry.injectParam).toBe('account');
        expect(entry.injectValue).toBe('myaccount');
        expect(entry.envOverrides).toEqual({ AZURE_CLIENT_ID: 'cid', AZURE_TENANT_ID: 'tid' });
    });

    it('parses exact tool name (no wildcard)', () => {
        const entry = parseRouterSpec('my_tool.endpoint="https://api.example.com"');
        expect(entry.toolPattern).toBe('my_tool');
        expect(entry.injectParam).toBe('endpoint');
        expect(entry.injectValue).toBe('https://api.example.com');
    });

    it('parses wildcard matching all tools', () => {
        const entry = parseRouterSpec('*.param="value"');
        expect(entry.toolPattern).toBe('*');
        expect(entry.injectParam).toBe('param');
        expect(entry.injectValue).toBe('value');
    });

    it('parses empty inject value', () => {
        const entry = parseRouterSpec('kusto_*.cluster_uri=""');
        expect(entry.injectValue).toBe('');
    });

    it('throws on missing first segment', () => {
        expect(() => parseRouterSpec('')).toThrow();
    });

    it('throws on malformed first segment (no dot)', () => {
        expect(() => parseRouterSpec('kusto_cluster_uri="value"')).toThrow();
    });

    it('throws on malformed env segment', () => {
        expect(() =>
            parseRouterSpec('kusto_*.cluster_uri="val"; BADVAR')
        ).toThrow();
    });
});

describe('computeDownstreamKey', () => {
    const entry1 = {
        toolPattern: 'kusto_*',
        injectParam: 'cluster_uri',
        injectValue: 'https://cluster1.kusto.windows.net',
        envOverrides: { AZURE_CLIENT_ID: 'abc123' },
    };

    const entry2 = {
        toolPattern: 'kusto_*',
        injectParam: 'cluster_uri',
        injectValue: 'https://cluster2.kusto.windows.net',
        envOverrides: { AZURE_CLIENT_ID: 'xyz456' },
    };

    const passthroughArgs = ['server', 'start', '--namespace', 'kusto'];

    it('returns a 16-char hex string', () => {
        const key = computeDownstreamKey(passthroughArgs, entry1);
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    it('same inputs produce same key (stability)', () => {
        expect(computeDownstreamKey(passthroughArgs, entry1)).toBe(
            computeDownstreamKey(passthroughArgs, entry1)
        );
    });

    it('different injectValues produce different keys', () => {
        expect(computeDownstreamKey(passthroughArgs, entry1)).not.toBe(
            computeDownstreamKey(passthroughArgs, entry2)
        );
    });

    it('different passthroughArgs produce different keys', () => {
        const otherArgs = ['server', 'start', '--namespace', 'cosmos'];
        expect(computeDownstreamKey(passthroughArgs, entry1)).not.toBe(
            computeDownstreamKey(otherArgs, entry1)
        );
    });

    it('different envOverrides with same injectValue produce same key (envOverrides not in hash)', () => {
        const e1 = { ...entry1, envOverrides: { AZURE_CLIENT_ID: 'abc' } };
        const e2 = { ...entry1, envOverrides: { AZURE_CLIENT_ID: 'xyz' } };
        expect(computeDownstreamKey(passthroughArgs, e1)).toBe(
            computeDownstreamKey(passthroughArgs, e2)
        );
    });
});

describe('matchesPattern', () => {
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
