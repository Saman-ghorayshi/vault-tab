import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalize_tab_url,
    scan_for_duplicates,
    deduplicate_groups
} from '../common/dedup.js';
import {
    format_as_markdown,
    format_as_html_bookmarks,
    format_as_csv
} from '../common/export_formats.js';

test('DEDUP: URL normalization strips tracking params and trailing slash', () => {
    const raw1 = 'https://github.com/Saman-ghorayshi/vault-tab/?utm_source=twitter&ref=share';
    const raw2 = 'https://github.com/Saman-ghorayshi/vault-tab';

    assert.equal(normalize_tab_url(raw1), normalize_tab_url(raw2));
    assert.equal(normalize_tab_url('https://example.com/'), 'https://example.com');
});

test('DEDUP: Scans duplicates across multiple sessions', () => {
    const groups = [
        {
            id: 'group1',
            name: 'Session 1',
            tabs: [
                { url: 'https://hyperliquid.xyz', title: 'Hyperliquid' },
                { url: 'https://solana.com', title: 'Solana' }
            ]
        },
        {
            id: 'group2',
            name: 'Session 2',
            tabs: [
                { url: 'https://hyperliquid.xyz?utm_source=telegram', title: 'Hyperliquid Trading' },
                { url: 'https://rust-lang.org', title: 'Rust' },
                { url: 'https://solana.com/', title: 'Solana Official' }
            ]
        }
    ];

    const result = scan_for_duplicates(groups);
    assert.equal(result.duplicateCount, 2, 'Must detect 2 duplicate tabs');
    assert.equal(result.duplicatesByUrl.size, 2);
});

test('DEDUP: Deduplicates groups preserving first unique occurrence', () => {
    const groups = [
        {
            id: 'g1',
            name: 'G1',
            tabs: [
                { id: 't1', url: 'https://example.com', title: 'T1' },
                { id: 't2', url: 'https://duplicate.com', title: 'T2' }
            ]
        },
        {
            id: 'g2',
            name: 'G2',
            tabs: [
                { id: 't3', url: 'https://duplicate.com?ref=1', title: 'T3' },
                { id: 't4', url: 'https://unique.com', title: 'T4' }
            ]
        }
    ];

    const { cleanedGroups, removedCount } = deduplicate_groups(groups);
    assert.equal(removedCount, 1);
    assert.equal(cleanedGroups[0].tabs.length, 2);
    assert.equal(cleanedGroups[1].tabs.length, 1);
    assert.equal(cleanedGroups[1].tabs[0].url, 'https://unique.com');
});

test('EXPORTER: Formats session as GitHub Markdown', () => {
    const group = {
        name: 'Solana Security Audit',
        date: '2026-11-05T02:00:00.000Z',
        tabs: [
            { url: 'https://anchor-lang.com', title: 'Anchor [Official]' },
            { url: 'https://solana.com', title: 'Solana' }
        ]
    };

    const md = format_as_markdown(group);
    assert.ok(md.includes('# Solana Security Audit'));
    assert.ok(md.includes('1. [Anchor \\[Official\\]](https://anchor-lang.com)'));
    assert.ok(md.includes('2. [Solana](https://solana.com)'));
    assert.ok(md.includes('Exported securely via [VaultTab]'));
});

test('EXPORTER: Formats session as Netscape HTML Bookmarks', () => {
    const group = {
        name: 'DeFi Portfolio',
        date: '2026-11-05T02:00:00.000Z',
        tabs: [
            { url: 'https://uniswap.org', title: 'Uniswap' }
        ]
    };

    const html = format_as_html_bookmarks(group);
    assert.ok(html.includes('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
    assert.ok(html.includes('<H3 ADD_DATE='));
    assert.ok(html.includes('<A HREF="https://uniswap.org"'));
    assert.ok(html.includes('Uniswap</A>'));
});

test('EXPORTER: Formats session as CSV', () => {
    const group = {
        name: 'Research, Week 44',
        date: '2026-11-05',
        tabs: [
            { url: 'https://arxiv.org', title: 'ArXiv "Paper"' }
        ]
    };

    const csv = format_as_csv(group);
    assert.ok(csv.startsWith('"Index","Title","URL","SessionName","Date"'));
    assert.ok(csv.includes('"1","ArXiv ""Paper"""'));
    assert.ok(csv.includes('"Research, Week 44"'));
});
