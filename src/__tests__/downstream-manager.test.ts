/**
 * Tests for normalizeClusterUrl and DownstreamManager routing logic.
 */

import { describe, it, expect } from 'vitest';
import { normalizeClusterUrl } from '../downstream-manager.js';

describe('normalizeClusterUrl', () => {
    it('lowercases the URL', () => {
        expect(normalizeClusterUrl('https://MyCluster.Kusto.Windows.Net')).toBe(
            'https://mycluster.kusto.windows.net'
        );
    });

    it('removes trailing slashes', () => {
        expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/')).toBe(
            'https://mycluster.kusto.windows.net'
        );
        expect(normalizeClusterUrl('https://mycluster.kusto.windows.net///')).toBe(
            'https://mycluster.kusto.windows.net'
        );
    });

    it('adds https:// prefix if missing', () => {
        expect(normalizeClusterUrl('mycluster.kusto.windows.net')).toBe(
            'https://mycluster.kusto.windows.net'
        );
    });

    it('preserves http:// prefix', () => {
        expect(normalizeClusterUrl('http://mycluster.kusto.windows.net')).toBe(
            'http://mycluster.kusto.windows.net'
        );
    });

    it('trims whitespace', () => {
        expect(normalizeClusterUrl('  https://mycluster.kusto.windows.net  ')).toBe(
            'https://mycluster.kusto.windows.net'
        );
    });

    it('handles complex URLs', () => {
        expect(
            normalizeClusterUrl('https://MyCluster.EastUS.Kusto.Windows.Net/')
        ).toBe('https://mycluster.eastus.kusto.windows.net');
    });
});
