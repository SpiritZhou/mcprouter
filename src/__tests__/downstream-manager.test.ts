/**
 * Tests for normalizeKey and DownstreamManager routing logic.
 */

import { describe, it, expect } from 'vitest';
import { normalizeKey } from '../downstream-manager.js';

describe('normalizeKey', () => {
    it('lowercases the key', () => {
        expect(normalizeKey('https://MyCluster.Kusto.Windows.Net')).toBe(
            'https://mycluster.kusto.windows.net'
        );
    });

    it('trims whitespace', () => {
        expect(normalizeKey('  https://mycluster.kusto.windows.net  ')).toBe(
            'https://mycluster.kusto.windows.net'
        );
    });

    it('handles non-URL keys', () => {
        expect(normalizeKey('EastUS:MyAccount')).toBe('eastus:myaccount');
    });

    it('handles plain names', () => {
        expect(normalizeKey('  MyServer  ')).toBe('myserver');
    });

    it('preserves special characters', () => {
        expect(normalizeKey('Region:Account/DB')).toBe('region:account/db');
    });

    it('handles complex URLs', () => {
        expect(
            normalizeKey('https://MyCluster.EastUS.Kusto.Windows.Net/')
        ).toBe('https://mycluster.eastus.kusto.windows.net/');
    });
});
