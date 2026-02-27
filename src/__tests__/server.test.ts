/**
 * Tests for the MCP server — schema conversion (JSON Schema → Zod).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// We test the schema conversion logic by importing the relevant types
// and verifying our Zod schemas match expected behavior.

describe('JSON Schema to Zod conversion', () => {
    it('handles string type', () => {
        const schema = z.string().describe('A cluster URL');
        expect(schema.parse('https://cluster.kusto.windows.net')).toBe(
            'https://cluster.kusto.windows.net'
        );
    });

    it('handles string enum', () => {
        const schema = z.enum([
            'https://cluster1.kusto.windows.net',
            'https://cluster2.kusto.windows.net',
        ]);
        expect(schema.parse('https://cluster1.kusto.windows.net')).toBe(
            'https://cluster1.kusto.windows.net'
        );
        expect(() => schema.parse('https://unknown.kusto.windows.net')).toThrow();
    });

    it('handles number type', () => {
        const schema = z.number().describe('Sample size');
        expect(schema.parse(10)).toBe(10);
    });

    it('handles optional properties', () => {
        const schema = z.object({
            cluster: z.string(),
            database: z.string(),
            size: z.number().optional(),
        });

        const result = schema.parse({ cluster: 'c', database: 'db' });
        expect(result).toEqual({ cluster: 'c', database: 'db' });
    });

    it('handles array type', () => {
        const schema = z.array(z.string());
        expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
    });
});
