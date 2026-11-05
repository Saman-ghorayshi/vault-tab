import test from 'node:test';
import assert from 'node:assert/strict';

// Set up chrome storage mock before importing storage.js
const mockStore = {};
globalThis.chrome = globalThis.chrome || {
    storage: {
        local: {
            get: async (keys) => {
                if (typeof keys === 'string') return { [keys]: mockStore[keys] };
                if (Array.isArray(keys)) {
                    const res = {};
                    keys.forEach(k => res[k] = mockStore[k]);
                    return res;
                }
                if (keys && typeof keys === 'object') {
                    const res = {};
                    for (const k in keys) res[k] = mockStore[k] !== undefined ? mockStore[k] : keys[k];
                    return res;
                }
                return { ...mockStore };
            },
            set: async (items) => {
                Object.assign(mockStore, items);
            },
            remove: async (key) => {
                delete mockStore[key];
            }
        }
    }
};

import { normalize_tab_url, deduplicate_groups, scan_for_duplicates } from '../common/dedup.js';
import { format_as_markdown, format_as_csv, format_as_html_bookmarks } from '../common/export_formats.js';
import { base64url_to_buffer, create_p2p_share_link, parse_p2p_share_link } from '../common/p2p_share.js';
import { create_audit_manifest, sign_audit_manifest_ecdsa, verify_audit_proof } from '../common/freeze_frame.js';
import { sanitize_group_color, serialize_tabs_with_groups, plan_group_reconstruction } from '../common/tab_groups.js';
import { purge_expired_or_burner_groups } from '../common/storage.js';

test('AUDIT: Deduplication URL normalization handles case-insensitive utm_* and ad trackers', () => {
    // 1. YouTube functional param preserved, tracking stripped
    const yt = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&UTM_SOURCE=twitter&UTM_MEDIUM=social&ref=share';
    assert.equal(normalize_tab_url(yt), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    // 2. Trailing slashes stripped on paths
    const repo = 'https://github.com/Saman-ghorayshi/vault-tab///';
    assert.equal(normalize_tab_url(repo), 'https://github.com/Saman-ghorayshi/vault-tab');

    // 3. Various trackers stripped: gclid, fbclid, igshid, twclid, mc_cid
    const tracked = 'https://news.ycombinator.com/item?id=12345&fbclid=IwAR234&gclid=EAIaIQobChMI&twclid=123&igshid=abc';
    assert.equal(normalize_tab_url(tracked), 'https://news.ycombinator.com/item?id=12345');

    // 4. Dangling ? stripped
    const dangling = 'https://example.com/?ref=homepage';
    assert.equal(normalize_tab_url(dangling), 'https://example.com');
});

test('AUDIT: Deduplication preserving group structure when group becomes empty', () => {
    const group1 = {
        id: 'g1',
        name: 'Work',
        tabs: [
            { id: 't1', url: 'https://github.com', title: 'GitHub' },
            { id: 't2', url: 'https://google.com', title: 'Google' }
        ]
    };
    const group2 = {
        id: 'g2',
        name: 'Redundant Group',
        tabs: [
            { id: 't3', url: 'https://github.com/?utm_source=test', title: 'GitHub duplicate' },
            { id: 't4', url: 'https://google.com/', title: 'Google duplicate' }
        ]
    };

    const { cleanedGroups, removedCount } = deduplicate_groups([group1, group2]);
    assert.equal(removedCount, 2);
    assert.equal(cleanedGroups.length, 2);
    assert.equal(cleanedGroups[0].tabs.length, 2);
    // group2 tabs became empty, but group metadata and ID are intact
    assert.equal(cleanedGroups[1].tabs.length, 0);
    assert.equal(cleanedGroups[1].id, 'g2');
    assert.equal(cleanedGroups[1].name, 'Redundant Group');
});

test('AUDIT: Multi-Format Exporter Markdown escaping (parens, brackets, newlines)', () => {
    const session = {
        name: 'Math Research',
        date: '2026-11-05T12:00:00Z',
        tabs: [
            {
                title: 'Wikipedia [Function (Mathematics)]\nWith Unsafe Newline',
                url: 'https://en.wikipedia.org/wiki/Function_(mathematics)'
            }
        ]
    };

    const md = format_as_markdown(session);
    // Link must use angle brackets <URL> so nested parentheses don't break markdown link
    assert.ok(md.includes('(<https://en.wikipedia.org/wiki/Function_(mathematics)>)'), 'Must enclose URL with parens in angle brackets');
    // Brackets must be escaped
    assert.ok(md.includes('\\[Function (Mathematics)\\]'), 'Must escape square brackets in title');
    // Newline must be flattened
    assert.ok(!md.includes('\nWith Unsafe Newline\n'), 'Newlines inside title must be flattened');
});

test('AUDIT: Multi-Format Exporter CSV Formula Injection Defense (CWE-1236)', () => {
    const maliciousSession = {
        name: '=cmd|\'/C calc\'!A0',
        date: '2026-11-05',
        tabs: [
            { title: '@DDE("cmd";"/C calc";"__DdeLink__")', url: '+https://evil.com' },
            { title: '-1+1', url: '\tjavascript:alert(1)' }
        ]
    };

    const csv = format_as_csv(maliciousSession);
    const lines = csv.trim().split('\n');
    // Verify each malicious cell starts with single quote ' to neutralize formulas
    assert.ok(lines[1].includes("'@DDE"), 'Formula starting with @ must be escaped');
    assert.ok(lines[1].includes("'+https://evil.com"), 'Formula starting with + must be escaped');
    assert.ok(lines[1].includes("'=cmd|"), 'Group name starting with = must be escaped');
    assert.ok(lines[2].includes("'-1+1"), 'Formula starting with - must be escaped');
    assert.ok(lines[2].includes("'\tjavascript"), 'Formula starting with tab must be escaped');
});

test('AUDIT: Multi-Format Exporter Netscape Bookmarks XSS Escaping', () => {
    const session = {
        name: '<script>alert(1)</script>',
        date: '2026-11-05',
        tabs: [
            {
                title: '"><img src=x onerror=alert(2)>',
                url: 'https://example.com?q="><script>alert(3)</script>'
            }
        ]
    };

    const html = format_as_html_bookmarks(session);
    assert.ok(!html.includes('<script>'), 'Unescaped script tag must not appear');
    assert.ok(!html.includes('<img'), 'Unescaped img tag must not appear');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'));
});

test('AUDIT: Base64URL parsing gracefully rejects invalid characters', () => {
    assert.throws(() => {
        base64url_to_buffer('Invalid Base64 @@@!#$*');
    }, /Failed to decode Base64URL string/);
});

test('AUDIT: Freeze-Frame verify_audit_proof rejects null or missing manifest', async () => {
    await assert.rejects(
        async () => {
            await verify_audit_proof({ format: 'vaulttab-proof-v1', signer_type: 'ecdsa-p256' });
        },
        /missing or invalid manifest object/
    );
});

test('AUDIT: Burner Panic Wipe purges both is_burner and burn_on_restore sessions', async () => {
    const { save_user, save_tab_groups, get_tab_groups } = await import('../common/storage.js');
    const AUDIT_USER = 'audit_burn_user';

    await save_user({
        username: AUDIT_USER,
        password_salt: 'dummy_salt',
        password_verifier: { iv: 'iv', ciphertext: 'ct' },
        tab_groups: []
    });

    const now = Date.now();
    const mock_groups = [
        { id: 'normal_1', iv: 'iv1', ciphertext: 'c1' },
        { id: 'burner_flagged', iv: 'iv2', ciphertext: 'c2', is_burner: true },
        { id: 'burn_on_restore_only', iv: 'iv3', ciphertext: 'c3', burn_on_restore: true },
        { id: 'expired_ttl', iv: 'iv4', ciphertext: 'c4', expires_at: now - 5000 }
    ];

    await save_tab_groups(AUDIT_USER, mock_groups);

    // 1. Regular purge (TTL expiration only, purge_all_burners = false)
    const purgedTtl = await purge_expired_or_burner_groups(AUDIT_USER, false);
    assert.equal(purgedTtl, 1);
    let current = await get_tab_groups(AUDIT_USER);
    assert.equal(current.length, 3);
    assert.equal(current.find(g => g.id === 'expired_ttl'), undefined);

    // 2. Emergency Panic Wipe (purge_all_burners = true)
    const purgedPanic = await purge_expired_or_burner_groups(AUDIT_USER, true);
    assert.equal(purgedPanic, 2);
    current = await get_tab_groups(AUDIT_USER);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, 'normal_1');
});
