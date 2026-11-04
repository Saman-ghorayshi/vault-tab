import test from 'node:test';
import assert from 'node:assert/strict';
import {
    create_p2p_share_link,
    parse_p2p_share_link,
    buffer_to_base64url,
    base64url_to_buffer,
    sanitize_shared_workspace
} from '../common/p2p_share.js';
import { generate_qr_svg } from '../common/qr.js';

test('P2P SHARE: Base64URL encoding round-trip', () => {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    const b64url = buffer_to_base64url(raw.buffer);

    assert.ok(!b64url.includes('+'), 'Base64URL must not contain +');
    assert.ok(!b64url.includes('/'), 'Base64URL must not contain /');
    assert.ok(!b64url.endsWith('='), 'Base64URL must not contain padding =');

    const restored = new Uint8Array(base64url_to_buffer(b64url));
    assert.deepEqual(restored, raw, 'Decoded buffer must match original byte-for-byte');
});

test('P2P SHARE: Full encryption, gzip compression, and decryption round-trip', async () => {
    const originalWorkspace = {
        name: 'Distributed Systems Research',
        created_at: '2026-11-04T12:00:00.000Z',
        tags: ['raft', 'consensus', 'security'],
        is_burner: false,
        tabs: [
            { url: 'https://raft.github.io/', title: 'Raft Consensus Algorithm', favIconUrl: 'https://raft.github.io/favicon.ico' },
            { url: 'https://github.com/etcd-io/etcd', title: 'etcd Distributed KV Store', favIconUrl: 'https://github.com/favicon.ico' },
            { url: 'https://lamport.azurewebsites.net/pubs/paxos-simple.pdf', title: 'Paxos Made Simple', favIconUrl: '' }
        ]
    };

    const sharePackage = await create_p2p_share_link(originalWorkspace);

    assert.ok(sharePackage.url.startsWith('https://saman-ghorayshi.github.io/vault-tab/#share=v1.'), 'URL must contain version prefix');
    assert.ok(sharePackage.qrSvg.startsWith('<svg'), 'QR SVG must be generated');
    assert.equal(sharePackage.tabCount, 3);
    assert.ok(sharePackage.compressedBytes < sharePackage.originalBytes, 'Gzip must compress the JSON payload');

    const parsedWorkspace = await parse_p2p_share_link(sharePackage.url);

    assert.equal(parsedWorkspace.name, originalWorkspace.name);
    assert.deepEqual(parsedWorkspace.tags, originalWorkspace.tags);
    assert.equal(parsedWorkspace.tabs.length, 3);
    assert.equal(parsedWorkspace.tabs[0].url, 'https://raft.github.io/');
    assert.equal(parsedWorkspace.tabs[0].title, 'Raft Consensus Algorithm');
});

test('P2P SHARE: Sanitizes malicious tabs & schemes (XSS and Scheme Injection)', () => {
    const dangerousWorkspace = {
        name: '   Exploit Test   ',
        tabs: [
            { url: 'javascript:alert(document.cookie)', title: 'XSS Attack' },
            { url: 'data:text/html,<script>steal()</script>', title: 'Data URL' },
            { url: 'chrome://settings', title: 'Internal Chrome' },
            { url: 'view-source:https://bank.com', title: 'View Source' },
            { url: 'https://clean-site.org/docs', title: 'Clean Tab', favIconUrl: 'javascript:void(0)' }
        ]
    };

    const sanitized = sanitize_shared_workspace(dangerousWorkspace);

    assert.equal(sanitized.tabs.length, 1, 'Only clean HTTPS tab should remain');
    assert.equal(sanitized.tabs[0].url, 'https://clean-site.org/docs');
    assert.equal(sanitized.tabs[0].favIconUrl, '', 'Dangerous favicon scheme must be cleared');
    assert.equal(sanitized.name, 'Exploit Test', 'Whitespace trimmed');
});

test('P2P SHARE: Rejects empty or exclusively dangerous workspaces', () => {
    assert.throws(() => {
        sanitize_shared_workspace({
            name: 'All Bad',
            tabs: [{ url: 'javascript:alert(1)' }]
        });
    }, /No valid or safe tabs/);
});

test('P2P SHARE: Tampered ciphertext or wrong auth tag is strictly rejected', async () => {
    const workspace = {
        name: 'Secure Vault',
        tabs: [{ url: 'https://security.org', title: 'Security' }]
    };

    const sharePackage = await create_p2p_share_link(workspace);
    const hash = sharePackage.hash;

    const parts = hash.slice('#share='.length).split('.');
    assert.equal(parts.length, 4);

    // Tamper with the ciphertext (parts[3])
    const ctBytes = new Uint8Array(base64url_to_buffer(parts[3]));
    ctBytes[0] ^= 0x01; // flip 1 bit
    parts[3] = buffer_to_base64url(ctBytes.buffer);

    const tamperedHash = `#share=${parts.join('.')}`;

    await assert.rejects(
        async () => {
            await parse_p2p_share_link(tamperedHash);
        },
        /Decryption failed: Authentication tag mismatch/
    );
});

test('P2P SHARE: Rejects malformed hash structure', async () => {
    await assert.rejects(
        async () => {
            await parse_p2p_share_link('#share=v1.invalid.format');
        },
        /expected 4 dot-separated components/
    );

    await assert.rejects(
        async () => {
            await parse_p2p_share_link('#share=v99.a.b.c');
        },
        /Unsupported share format version/
    );
});

test('QR: Generates valid accessible SVG', () => {
    const svg = generate_qr_svg('https://saman-ghorayshi.github.io/vault-tab/#share=test', {
        title: 'VaultTab Unit Test'
    });

    assert.ok(svg.startsWith('<svg'), 'Starts with svg tag');
    assert.ok(svg.includes('role="img"'), 'Includes accessible role');
    assert.ok(svg.includes('<title>VaultTab Unit Test</title>'), 'Includes title element');
    assert.ok(svg.includes('</svg>'), 'Closes svg tag');
});
