import qrcode from './qrcode.js';

/**
 * Generate an SVG string representing a QR code for arbitrary text or URL.
 * Uses JIS X 0510 / QR Code standard with automatic version detection.
 *
 * @param {string} text - The URL or text string to encode
 * @param {object} [options]
 * @param {number} [options.cellSize=4] - Pixel size per module/cell
 * @param {number} [options.margin=8] - Margin around the code in module units
 * @param {'L'|'M'|'Q'|'H'} [options.errorCorrection='M'] - QR error correction level
 * @param {string} [options.title='VaultTab QR Code'] - Accessible title attribute
 * @returns {string} Clean SVG markup string
 */
export function generate_qr_svg(text, options = {}) {
    if (!text || typeof text !== 'string') {
        throw new Error('QR generation requires a non-empty string payload.');
    }

    const cellSize = options.cellSize || 4;
    const margin = options.margin !== undefined ? options.margin : 8;
    const errorCorrection = options.errorCorrection || 'M';
    const title = options.title || 'VaultTab QR Code';

    // Type 0 enables auto-detection of the smallest version that accommodates the payload
    const qr = qrcode(0, errorCorrection);
    qr.addData(text);
    qr.make();

    // Use built-in SVG generator
    let svgTag = qr.createSvgTag(cellSize, margin);

    // Ensure responsive attributes and accessibility
    if (!svgTag.includes('<title>')) {
        svgTag = svgTag.replace('<svg ', `<svg role="img" aria-label="${title}" `);
        svgTag = svgTag.replace('>', `><title>${title}</title>`);
    }

    return svgTag;
}

/**
 * Generate a Data URL for the QR code SVG (suitable for <img> src or downloads).
 *
 * @param {string} text
 * @param {object} [options]
 * @returns {string} Data URL string
 */
export function generate_qr_data_url(text, options = {}) {
    const svg = generate_qr_svg(text, options);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
