import {
    der_to_raw_ecdsa_signature,
    verify_assertion,
    make_assertion_options,
    serialize_assertion
} from './webauthn.js';
import { buffer_to_base64url, base64url_to_buffer } from './p2p_share.js';

export const PROOF_FORMAT_VERSION = 'vaulttab-proof-v1';

/**
 * Deterministic JSON canonicalization (RFC 8785 compliant key sorting).
 * Ensures identical cryptographic hashes regardless of object key order.
 *
 * @param {any} obj
 * @returns {string}
 */
export function canonicalize_json(obj) {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalize_json).join(',') + ']';
    }
    const sortedKeys = Object.keys(obj).sort();
    const entries = sortedKeys.map(k => JSON.stringify(k) + ':' + canonicalize_json(obj[k]));
    return '{' + entries.join(',') + '}';
}

/**
 * Compute SHA-256 digest of canonical manifest JSON.
 *
 * @param {object} manifest
 * @returns {Promise<{ canonical: string, hashBuffer: ArrayBuffer, hashHex: string, hashBase64Url: string }>}
 */
export async function compute_manifest_digest(manifest) {
    const canonical = canonicalize_json(manifest);
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
    const hashBytes = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const hashBase64Url = buffer_to_base64url(hashBuffer);

    return {
        canonical,
        hashBuffer,
        hashHex,
        hashBase64Url
    };
}

/**
 * Build a canonical audit manifest from a tab group.
 * Tabs are sorted alphabetically by URL to ensure deterministic state proofs.
 *
 * @param {object} group - Object with { name, tabs, date }
 * @param {string} [auditor='anonymous']
 * @returns {object} Canonical audit manifest
 */
export function create_audit_manifest(group, auditor = 'anonymous') {
    if (!group || !Array.isArray(group.tabs) || group.tabs.length === 0) {
        throw new Error('Audit manifest requires at least one tab.');
    }

    const tabs = group.tabs
        .filter(t => t && t.url && typeof t.url === 'string')
        .map(t => ({
            url: t.url.trim(),
            title: typeof t.title === 'string' ? t.title.trim() : 'Untitled'
        }));

    tabs.sort((a, b) => a.url.localeCompare(b.url));

    return {
        format: PROOF_FORMAT_VERSION,
        type: 'forensic-audit-snapshot',
        auditor: (auditor && typeof auditor === 'string') ? auditor.trim() : 'anonymous',
        session_name: group.name ? group.name.trim() : 'Audit Session',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomUUID(),
        tab_count: tabs.length,
        tabs
    };
}

/**
 * Sign an audit manifest using a software ECDSA P-256 keypair (for testing or standalone proof generation).
 *
 * @param {object} manifest
 * @param {CryptoKeyPair} keyPair
 * @returns {Promise<object>} Complete .vaultproof JSON object
 */
export async function sign_audit_manifest_ecdsa(manifest, keyPair) {
    const { hashBuffer, hashHex } = await compute_manifest_digest(manifest);
    const signatureBuffer = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        hashBuffer
    );

    const spkiBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const spkiB64 = buffer_to_base64url(spkiBuffer);
    const sigB64 = buffer_to_base64url(signatureBuffer);

    return {
        format: PROOF_FORMAT_VERSION,
        signer_type: 'ecdsa-p256',
        manifest,
        manifest_hash: hashHex,
        signature: sigB64,
        public_key_spki: spkiB64
    };
}

/**
 * Sign an audit manifest with a WebAuthn Hardware Key assertion.
 *
 * @param {object} manifest
 * @param {string} credentialIdB64
 * @param {string} publicKeyCborB64
 * @returns {Promise<object>} Hardware-signed .vaultproof JSON object
 */
export async function sign_audit_manifest_webauthn(manifest, credentialIdB64, publicKeyCborB64) {
    if (!navigator.credentials || !navigator.credentials.get) {
        throw new Error('WebAuthn hardware signing is not supported in this environment.');
    }

    const { hashBuffer, hashHex, hashBase64Url } = await compute_manifest_digest(manifest);
    const options = make_assertion_options(hashBase64Url, credentialIdB64);
    const assertion = await navigator.credentials.get({ publicKey: options });

    if (!assertion) {
        throw new Error('User cancelled WebAuthn hardware proof assertion.');
    }

    const serializedAssertion = serialize_assertion(assertion);

    return {
        format: PROOF_FORMAT_VERSION,
        signer_type: 'webauthn',
        manifest,
        manifest_hash: hashHex,
        credential_id: credentialIdB64,
        public_key_cbor: publicKeyCborB64,
        assertion: serializedAssertion
    };
}

/**
 * Verify a .vaultproof bundle. Validates cryptographic state digest and signature.
 *
 * @param {object} proofBundle
 * @param {string} [expectedOrigin] - Origin for WebAuthn assertion (e.g. extension origin)
 * @returns {Promise<{ valid: boolean, auditor: string, sessionName: string, tabCount: number, timestamp: string, signerType: string }>}
 */
export async function verify_audit_proof(proofBundle, expectedOrigin = null) {
    if (!proofBundle || typeof proofBundle !== 'object') {
        throw new Error('Invalid proof bundle: must be an object.');
    }

    if (proofBundle.format !== PROOF_FORMAT_VERSION) {
        throw new Error(`Unsupported proof bundle format: ${proofBundle.format}`);
    }

    // 1. Recompute canonical digest
    const { hashHex, hashBuffer, hashBase64Url } = await compute_manifest_digest(proofBundle.manifest);
    if (hashHex !== proofBundle.manifest_hash) {
        throw new Error(`Cryptographic hash mismatch! Expected ${proofBundle.manifest_hash}, calculated ${hashHex}. Manifest has been tampered with.`);
    }

    // 2. Verify signature according to signer type
    if (proofBundle.signer_type === 'ecdsa-p256') {
        if (!proofBundle.public_key_spki || !proofBundle.signature) {
            throw new Error('Missing public key or signature in ECDSA proof.');
        }

        const spkiBuffer = base64url_to_buffer(proofBundle.public_key_spki);
        const sigBuffer = base64url_to_buffer(proofBundle.signature);

        const publicKey = await crypto.subtle.importKey(
            'spki',
            spkiBuffer,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        );

        const isValid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            publicKey,
            sigBuffer,
            hashBuffer
        );

        if (!isValid) {
            throw new Error('ECDSA P-256 signature verification failed: signature does not match manifest hash.');
        }

        return {
            valid: true,
            auditor: proofBundle.manifest.auditor,
            sessionName: proofBundle.manifest.session_name,
            tabCount: proofBundle.manifest.tab_count,
            timestamp: proofBundle.manifest.timestamp,
            signerType: 'ECDSA P-256 (Hardware/Software)'
        };
    } else if (proofBundle.signer_type === 'webauthn') {
        if (!proofBundle.public_key_cbor || !proofBundle.assertion) {
            throw new Error('Missing public_key_cbor or assertion in WebAuthn proof.');
        }

        const origin = expectedOrigin || (typeof window !== 'undefined' ? window.location.origin : 'chrome-extension://' + chrome.runtime.id);
        const isValid = await verify_assertion(
            proofBundle.public_key_cbor,
            hashBase64Url,
            proofBundle.assertion,
            origin
        );

        if (!isValid) {
            throw new Error('WebAuthn hardware proof verification failed.');
        }

        return {
            valid: true,
            auditor: proofBundle.manifest.auditor,
            sessionName: proofBundle.manifest.session_name,
            tabCount: proofBundle.manifest.tab_count,
            timestamp: proofBundle.manifest.timestamp,
            signerType: 'WebAuthn FIDO2 Hardware Authenticator'
        };
    } else {
        throw new Error(`Unknown signer type: ${proofBundle.signer_type}`);
    }
}
