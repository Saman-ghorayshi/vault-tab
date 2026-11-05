import { is_unsaveable_url } from './urls.js';
import { generate_qr_svg, generate_qr_data_url } from './qr.js';

export const P2P_SHARE_VERSION = 'v1';
export const DEFAULT_SHARE_BASE_URL = 'https://saman-ghorayshi.github.io/vault-tab/';

/**
 * Convert ArrayBuffer to URL-safe Base64 (RFC 4648 §5).
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function buffer_to_base64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert URL-safe Base64 back to ArrayBuffer.
 * @param {string} str
 * @returns {ArrayBuffer}
 */
export function base64url_to_buffer(str) {
    if (!str || typeof str !== 'string') {
        throw new Error('Invalid base64url string.');
    }
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) {
        b64 += '=';
    }
    let binary;
    try {
        binary = atob(b64);
    } catch (_) {
        throw new Error('Failed to decode Base64URL string: malformed characters or padding.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Gzip-compress a string or UTF-8 buffer if CompressionStream is available.
 * @param {string} jsonString
 * @returns {Promise<Uint8Array>}
 */
async function compress_json_string(jsonString) {
    const encoder = new TextEncoder();
    const rawBytes = encoder.encode(jsonString);

    if (typeof CompressionStream !== 'undefined') {
        try {
            const stream = new Blob([rawBytes]).stream();
            const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
            const compressedBuffer = await new Response(compressedStream).arrayBuffer();
            return new Uint8Array(compressedBuffer);
        } catch (e) {
            // Fallback to raw bytes if stream piping fails
            return rawBytes;
        }
    }
    return rawBytes;
}

/**
 * Decompress a gzip buffer or decode UTF-8.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function decompress_to_json_string(bytes) {
    // Check for GZIP magic bytes (0x1f 0x8b)
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

    if (isGzip && typeof DecompressionStream !== 'undefined') {
        try {
            const stream = new Blob([bytes]).stream();
            const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
            return await new Response(decompressedStream).text();
        } catch (e) {
            // Fallback to text decoding if stream fails
        }
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Validate and sanitize a shared workspace payload.
 * Strips any unsafe/internal URLs and prevents prototype pollution.
 * @param {object} payload
 * @returns {object}
 */
export function sanitize_shared_workspace(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Shared workspace payload must be a valid JSON object.');
    }

    if (!Array.isArray(payload.tabs) || payload.tabs.length === 0) {
        throw new Error('Shared workspace must contain at least one tab.');
    }

    const safeTabs = [];
    for (const tab of payload.tabs) {
        if (!tab || typeof tab !== 'object') continue;
        if (!tab.url || typeof tab.url !== 'string') continue;

        const rawUrl = tab.url.trim();
        if (is_unsaveable_url(rawUrl)) continue;

        safeTabs.push({
            url: rawUrl,
            title: typeof tab.title === 'string' ? tab.title.slice(0, 300) : 'Untitled',
            favIconUrl: typeof tab.favIconUrl === 'string' && !is_unsaveable_url(tab.favIconUrl)
                ? tab.favIconUrl
                : ''
        });
    }

    if (safeTabs.length === 0) {
        throw new Error('No valid or safe tabs found in shared workspace.');
    }

    const name = typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 100)
        : 'Shared Workspace';

    const tags = Array.isArray(payload.tags)
        ? payload.tags
            .filter(t => typeof t === 'string' && t.trim())
            .map(t => t.trim().slice(0, 30))
            .slice(0, 10)
        : [];

    return {
        name,
        tabs: safeTabs,
        tags,
        created_at: payload.created_at || new Date().toISOString(),
        is_burner: Boolean(payload.is_burner),
        expires_at: typeof payload.expires_at === 'number' ? payload.expires_at : null
    };
}

/**
 * Encrypt and package a workspace into an air-gapped serverless share link & QR code.
 *
 * @param {object} workspace - Object containing { name, tabs, tags, is_burner, expires_at }
 * @param {object} [options]
 * @param {string} [options.baseUrl=DEFAULT_SHARE_BASE_URL] - Portal base URL
 * @param {boolean} [options.includeQr=true] - Whether to generate QR SVG
 * @returns {Promise<{ url: string, hash: string, qrSvg: string|null, tabCount: number, originalBytes: number, compressedBytes: number }>}
 */
export function create_p2p_share_link(workspace, options = {}) {
    return (async () => {
        const sanitized = sanitize_shared_workspace(workspace);
        const jsonString = JSON.stringify(sanitized);
        const originalBytes = new TextEncoder().encode(jsonString).byteLength;

        // 1. Gzip compression
        const payloadBytes = await compress_json_string(jsonString);
        const compressedBytes = payloadBytes.byteLength;

        // 2. Generate ephemeral 256-bit AES-GCM key and 12-byte IV
        const subtle = crypto.subtle;
        const key = await subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
        const rawKeyBuffer = await subtle.exportKey('raw', key);
        const iv = crypto.getRandomValues(new Uint8Array(12));

        // 3. Encrypt payload
        const ciphertextBuffer = await subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            payloadBytes
        );

        // 4. Encode as Base64URL
        const ivB64 = buffer_to_base64url(iv.buffer);
        const keyB64 = buffer_to_base64url(rawKeyBuffer);
        const ctB64 = buffer_to_base64url(ciphertextBuffer);

        const hash = `#share=${P2P_SHARE_VERSION}.${ivB64}.${keyB64}.${ctB64}`;
        const baseUrl = options.baseUrl || DEFAULT_SHARE_BASE_URL;
        const url = `${baseUrl.replace(/#.*$/, '')}${hash}`;

        let qrSvg = null;
        if (options.includeQr !== false) {
            try {
                // Auto-scale QR code
                qrSvg = generate_qr_svg(url, { cellSize: 3, margin: 4, title: `VaultTab Share: ${sanitized.name}` });
            } catch (e) {
                // In case URL exceeds max QR capacity, fail gracefully without breaking URL generation
                console.warn('QR Code generation failed for long payload:', e);
            }
        }

        return {
            url,
            hash,
            qrSvg,
            tabCount: sanitized.tabs.length,
            originalBytes,
            compressedBytes
        };
    })();
}

/**
 * Decrypt and unpack a shared workspace link from a URL hash string or full URL.
 *
 * @param {string} hashOrUrl - e.g. "#share=v1.iv.key.ciphertext" or full URL
 * @returns {Promise<object>} Parsed and sanitized workspace object
 */
export function parse_p2p_share_link(hashOrUrl) {
    return (async () => {
        if (!hashOrUrl || typeof hashOrUrl !== 'string') {
            throw new Error('Share link or hash is required.');
        }

        let hashStr = hashOrUrl;
        const hashIdx = hashOrUrl.indexOf('#');
        if (hashIdx !== -1) {
            hashStr = hashOrUrl.slice(hashIdx);
        }

        if (!hashStr.startsWith('#share=')) {
            throw new Error('Invalid share link: missing "#share=" prefix.');
        }

        const payloadPart = hashStr.slice('#share='.length);
        const parts = payloadPart.split('.');
        if (parts.length !== 4) {
            throw new Error('Malformed share payload: expected 4 dot-separated components (v1.iv.key.ciphertext).');
        }

        const [version, ivB64, keyB64, ctB64] = parts;
        if (version !== P2P_SHARE_VERSION) {
            throw new Error(`Unsupported share format version: ${version}`);
        }

        const ivBuffer = base64url_to_buffer(ivB64);
        const keyBuffer = base64url_to_buffer(keyB64);
        const ctBuffer = base64url_to_buffer(ctB64);

        if (ivBuffer.byteLength !== 12) {
            throw new Error(`Invalid IV length: expected 12 bytes, got ${ivBuffer.byteLength}.`);
        }
        if (keyBuffer.byteLength !== 32) {
            throw new Error(`Invalid AES key length: expected 32 bytes, got ${keyBuffer.byteLength}.`);
        }
        if (ctBuffer.byteLength < 17) {
            throw new Error('Ciphertext is too short (must contain at least 1-byte payload + 16-byte GCM tag).');
        }

        // Import AES-GCM Key
        const subtle = crypto.subtle;
        const key = await subtle.importKey('raw', keyBuffer, 'AES-GCM', false, ['decrypt']);

        // Decrypt
        let decryptedBuffer;
        try {
            decryptedBuffer = await subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(ivBuffer), tagLength: 128 },
                key,
                ctBuffer
            );
        } catch (e) {
            throw new Error('Decryption failed: Authentication tag mismatch or corrupted payload.');
        }

        // Decompress Gzip
        const jsonString = await decompress_to_json_string(new Uint8Array(decryptedBuffer));
        let rawParsed;
        try {
            rawParsed = JSON.parse(jsonString);
        } catch (e) {
            throw new Error('Decrypted payload is not valid JSON.');
        }

        return sanitize_shared_workspace(rawParsed);
    })();
}
