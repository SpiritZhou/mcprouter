/**
 * Parsing utilities for the --router CLI argument format and downstream key hashing.
 *
 * --router spec format:
 *   toolPattern.injectParam="injectValue"[; ENV_KEY="envValue"]...
 *
 * Examples:
 *   kusto_*.cluster_uri="https://mycluster.kusto.windows.net"; AZURE_CLIENT_ID="abc123"
 *   cosmos_*.account="myaccount"; AZURE_CLIENT_ID="xyz"; AZURE_TENANT_ID="tenant1"
 *   *    (any tool, no additional env)  — not typical but valid if no env overrides are needed
 */

import { createHash } from 'node:crypto';
import type { RouterEntry } from './types.js';

/**
 * Parse a single --router flag value into a RouterEntry.
 *
 * Format: toolPattern.injectParam="injectValue"[; ENV_KEY="envValue"]...
 *
 * @throws Error if the spec is malformed
 */
export function parseRouterSpec(spec: string): RouterEntry {
    const segments = spec.split(';').map((s) => s.trim()).filter(Boolean);

    if (segments.length === 0) {
        throw new Error(
            `Invalid --router spec: "${spec}". ` +
            `Expected format: toolPattern.param="value"[; ENV_KEY="val"]`
        );
    }

    const firstSeg = segments[0]!;

    // Match: <toolPattern>.<injectParam>="<injectValue>"
    // toolPattern may contain: letters, digits, _, -, *
    // injectParam may contain: letters, digits, _, -
    const firstMatch = firstSeg.match(/^([^.]+)\.([^=\s]+)="([^"]*)"$/);
    if (!firstMatch) {
        throw new Error(
            `Invalid --router spec first segment: "${firstSeg}". ` +
            `Expected: toolPattern.param="value" (e.g. kusto_*.cluster_uri="https://...")`
        );
    }

    const toolPattern = firstMatch[1]!;
    const injectParam = firstMatch[2]!;
    const injectValue = firstMatch[3]!;

    const envOverrides: Record<string, string> = {};

    for (const seg of segments.slice(1)) {
        // Match: ENV_KEY="value"  (key: letters/digits/underscore, starting with letter or _)
        const envMatch = seg.match(/^([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"$/);
        if (!envMatch) {
            throw new Error(
                `Invalid --router spec env segment: "${seg}". ` +
                `Expected: ENV_KEY="value" (e.g. AZURE_CLIENT_ID="abc123")`
            );
        }
        envOverrides[envMatch[1]!] = envMatch[2]!;
    }

    return { toolPattern, injectParam, injectValue, envOverrides };
}

/**
 * Compute a stable, short (16-char hex) hash key for a RouterEntry + passthroughArgs combo.
 * The injectValue is always unique per downstream, so envOverrides are not included in the hash.
 *
 * Key format: sha256(passthroughArgs|injectParam=injectValue)[:16]
 */
export function computeDownstreamKey(passthroughArgs: string[], entry: RouterEntry): string {
    const data = [
        passthroughArgs.join(' '),
        `${entry.injectParam}=${entry.injectValue}`,
    ].join('|');

    return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Test whether a tool name matches a glob pattern.
 * Only the '*' wildcard is supported (matches any sequence of characters).
 *
 * Examples:
 *   matchesPattern('kusto_*', 'kusto_query')  → true
 *   matchesPattern('kusto_*', 'cosmos_query') → false
 *   matchesPattern('*',       'anything')     → true
 *   matchesPattern('kusto_query', 'kusto_query') → true (exact match)
 */
export function matchesPattern(pattern: string, name: string): boolean {
    if (!pattern.includes('*')) {
        return pattern === name;
    }
    // Escape regex special chars (excluding '*'), then replace '*' with '.*'
    const regexStr =
        '^' +
        pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape all regex specials except *
            .replace(/\*/g, '.*') +
        '$';
    return new RegExp(regexStr).test(name);
}
