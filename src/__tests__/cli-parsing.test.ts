/**
 * Tests for CLI argument parsing.
 */

import { describe, it, expect } from 'vitest';
import type { ClusterMapping } from '../types.js';

/**
 * Parse a --mapping value (extracted from index.ts for testability).
 */
function parseMapping(value: string): ClusterMapping {
    const eqIndex = value.indexOf('=');
    let clusterUrl: string;
    let identity: string;

    if (eqIndex === -1) {
        clusterUrl = value;
        identity = '';
    } else {
        clusterUrl = value.substring(0, eqIndex);
        identity = value.substring(eqIndex + 1);
    }

    if (!clusterUrl) {
        throw new Error(
            `Invalid mapping: "${value}". Expected format: clusterUrl=identity or clusterUrl`
        );
    }

    return { clusterUrl, identity };
}

describe('CLI parseMapping', () => {
    it('parses cluster=identity mapping', () => {
        const result = parseMapping(
            'https://cluster1.kusto.windows.net=/subscriptions/sub1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id1'
        );
        expect(result.clusterUrl).toBe('https://cluster1.kusto.windows.net');
        expect(result.identity).toBe(
            '/subscriptions/sub1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id1'
        );
    });

    it('parses cluster-only mapping (no identity)', () => {
        const result = parseMapping('https://cluster1.kusto.windows.net');
        expect(result.clusterUrl).toBe('https://cluster1.kusto.windows.net');
        expect(result.identity).toBe('');
    });

    it('handles identity with multiple = signs (resource IDs)', () => {
        const result = parseMapping(
            'https://cluster.kusto.windows.net=/sub/rg/id=with=equals'
        );
        expect(result.clusterUrl).toBe('https://cluster.kusto.windows.net');
        expect(result.identity).toBe('/sub/rg/id=with=equals');
    });

    it('throws on empty cluster URL', () => {
        expect(() => parseMapping('=/some/identity')).toThrow('Invalid mapping');
    });

    it('throws on empty string', () => {
        expect(() => parseMapping('')).toThrow('Invalid mapping');
    });
});
