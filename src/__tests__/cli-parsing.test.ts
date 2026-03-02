/**
 * Tests for CLI argument parsing.
 */

import { describe, it, expect } from 'vitest';
import type { DownstreamMapping } from '../types.js';

/**
 * Parse a --mapping value (extracted from index.ts for testability).
 */
function parseMapping(value: string): DownstreamMapping {
    const eqIndex = value.indexOf('=');
    let key: string;
    let identity: string;

    if (eqIndex === -1) {
        key = value;
        identity = '';
    } else {
        key = value.substring(0, eqIndex);
        identity = value.substring(eqIndex + 1);
    }

    if (!key) {
        throw new Error(
            `Invalid mapping: "${value}". Expected format: key=identity or key`
        );
    }

    return { key, identity };
}

describe('CLI parseMapping', () => {
    it('parses key=identity mapping', () => {
        const result = parseMapping(
            'https://cluster1.kusto.windows.net=/subscriptions/sub1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id1'
        );
        expect(result.key).toBe('https://cluster1.kusto.windows.net');
        expect(result.identity).toBe(
            '/subscriptions/sub1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id1'
        );
    });

    it('parses key-only mapping (no identity)', () => {
        const result = parseMapping('https://cluster1.kusto.windows.net');
        expect(result.key).toBe('https://cluster1.kusto.windows.net');
        expect(result.identity).toBe('');
    });

    it('handles identity with multiple = signs (resource IDs)', () => {
        const result = parseMapping(
            'https://cluster.kusto.windows.net=/sub/rg/id=with=equals'
        );
        expect(result.key).toBe('https://cluster.kusto.windows.net');
        expect(result.identity).toBe('/sub/rg/id=with=equals');
    });

    it('parses non-URL key formats', () => {
        const result = parseMapping('eastus:myaccount=some-identity');
        expect(result.key).toBe('eastus:myaccount');
        expect(result.identity).toBe('some-identity');
    });

    it('throws on empty key', () => {
        expect(() => parseMapping('=/some/identity')).toThrow('Invalid mapping');
    });

    it('throws on empty string', () => {
        expect(() => parseMapping('')).toThrow('Invalid mapping');
    });
});
