import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canonicalize_json,
    compute_manifest_digest,
    create_audit_manifest,
    sign_audit_manifest_ecdsa,
    verify_audit_proof
} from '../common/freeze_frame.js';

test('FREEZE-FRAME: Canonical JSON sorting determinism', () => {
    const objA = { z: 100, a: 'apple', m: { b: 2, a: 1 } };
    const objB = { a: 'apple', m: { a: 1, b: 2 }, z: 100 };

    assert.equal(canonicalize_json(objA), canonicalize_json(objB));
    assert.equal(canonicalize_json(objA), '{"a":"apple","m":{"a":1,"b":2},"z":100}');
});

test('FREEZE-FRAME: SHA-256 Manifest digest computation', async () => {
    const manifest = {
        format: 'vaulttab-proof-v1',
        auditor: 'Saman Ghorayshi',
        tab_count: 2,
        tabs: [
            { url: 'https://github.com/Saman-ghorayshi/vault-tab', title: 'VaultTab' },
            { url: 'https://hyperliquid.xyz', title: 'Hyperliquid' }
        ]
    };

    const digest1 = await compute_manifest_digest(manifest);
    const digest2 = await compute_manifest_digest(manifest);

    assert.equal(digest1.hashHex, digest2.hashHex);
    assert.equal(digest1.hashHex.length, 64, 'SHA-256 hex must be 64 characters');
});

test('FREEZE-FRAME: Deterministic tab sorting by URL', () => {
    const rawGroup = {
        name: 'Smart Contract Audit',
        tabs: [
            { url: 'https://zksync.io', title: 'zkSync' },
            { url: 'https://arbitrum.io', title: 'Arbitrum' },
            { url: 'https://ethereum.org', title: 'Ethereum' }
        ]
    };

    const manifest = create_audit_manifest(rawGroup, 'Lead Security Auditor');

    assert.equal(manifest.tabs.length, 3);
    assert.equal(manifest.tabs[0].url, 'https://arbitrum.io');
    assert.equal(manifest.tabs[1].url, 'https://ethereum.org');
    assert.equal(manifest.tabs[2].url, 'https://zksync.io');
    assert.equal(manifest.auditor, 'Lead Security Auditor');
});

test('FREEZE-FRAME: ECDSA P-256 Sign and Verify Round-Trip', async () => {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );

    const group = {
        name: 'Marinade Finance Code Review',
        tabs: [
            { url: 'https://github.com/marinade-finance/liquid-staking-program', title: 'Marinade Liquid Staking' },
            { url: 'https://docs.marinade.finance/', title: 'Marinade Docs' }
        ]
    };

    const manifest = create_audit_manifest(group, 'Saman Ghorayshi');
    const proofBundle = await sign_audit_manifest_ecdsa(manifest, keyPair);

    assert.equal(proofBundle.format, 'vaulttab-proof-v1');
    assert.equal(proofBundle.signer_type, 'ecdsa-p256');
    assert.ok(proofBundle.signature);
    assert.ok(proofBundle.public_key_spki);

    const verification = await verify_audit_proof(proofBundle);
    assert.equal(verification.valid, true);
    assert.equal(verification.auditor, 'Saman Ghorayshi');
    assert.equal(verification.tabCount, 2);
});

test('FREEZE-FRAME: Tampering with manifest is detected and rejected', async () => {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );

    const group = {
        name: 'Authentic Audit Session',
        tabs: [{ url: 'https://uniswap.org', title: 'Uniswap' }]
    };

    const manifest = create_audit_manifest(group, 'Alice');
    const proofBundle = await sign_audit_manifest_ecdsa(manifest, keyPair);

    // Maliciously tamper with a tab URL inside the signed manifest
    proofBundle.manifest.tabs[0].url = 'https://fake-phishing-uniswap.com';

    await assert.rejects(
        async () => {
            await verify_audit_proof(proofBundle);
        },
        /Cryptographic hash mismatch!/
    );
});

test('FREEZE-FRAME: Tampering with signature is detected and rejected', async () => {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    );

    const group = {
        name: 'Authentic Audit Session',
        tabs: [{ url: 'https://uniswap.org', title: 'Uniswap' }]
    };

    const manifest = create_audit_manifest(group, 'Alice');
    const proofBundle = await sign_audit_manifest_ecdsa(manifest, keyPair);

    // Tamper with signature
    proofBundle.signature = proofBundle.signature.slice(0, -4) + 'AAAA';

    await assert.rejects(
        async () => {
            await verify_audit_proof(proofBundle);
        },
        /ECDSA P-256 signature verification failed/
    );
});
