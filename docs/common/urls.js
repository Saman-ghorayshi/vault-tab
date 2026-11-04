// shared URL helpers for VaultTab
// keeps the unsaveable and unrestorable scheme lists in one place
// so popup, background, and manager all use the same definition

// URL schemes that cannot be saved as restorable tabs
const UNSAVEABLE_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'about:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'devtools:',
  'javascript:',
  'data:',
  'vbscript:',
  'blob:',
  'filesystem:',
  'view-source:'
];

// check if a URL is a local file path
export function is_local_file_url(url) {
  if (!url || typeof url !== 'string') return false;
  return url.trim().toLowerCase().startsWith('file://');
}

// check if a URL uses a browser-internal, dangerous, or scriptable scheme
export function is_unsaveable_url(url) {
  if (!url || typeof url !== 'string') return true;
  const trimmed = url.trim().toLowerCase();
  if (trimmed === '') return true;

  for (const scheme of UNSAVEABLE_SCHEMES) {
    if (trimmed.startsWith(scheme)) return true;
  }

  try {
    const parsed = new URL(url.trim());
    const proto = parsed.protocol.toLowerCase();
    if (UNSAVEABLE_SCHEMES.includes(proto)) return true;
  } catch (e) {
    // If not a standard URL, check if it matches a scheme pattern (e.g. "javascript:...")
    const scheme_match = trimmed.match(/^([a-z0-9+.-]+):/);
    if (scheme_match && UNSAVEABLE_SCHEMES.includes(scheme_match[1] + ':')) {
      return true;
    }
  }
  return false;
}

// determine the save status of a URL
// returns 'ok', 'unsaveable', or 'local_file'
export function get_url_status(url) {
  if (!url || typeof url !== 'string') return 'unsaveable';
  if (is_unsaveable_url(url)) return 'unsaveable';
  if (is_local_file_url(url)) return 'local_file';
  return 'ok';
}

// check if a URL can be restored by chrome.tabs.create / chrome.windows.create
// strictly whitelists valid web and local schemes to prevent scheme injection
export function is_restorable_url(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (is_unsaveable_url(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    // Restorable tabs in Chromium must be strictly http, https, or local file
    return proto === 'http:' || proto === 'https:' || proto === 'file:';
  } catch (e) {
    return false;
  }
}

// derive a display title from a URL
// returns the hostname, or 'Untitled' if the URL is invalid
export function derive_title_from_url(url, fallback_title) {
  if (fallback_title && typeof fallback_title === 'string' && fallback_title.trim() !== '') {
    return fallback_title.trim();
  }
  if (!url || typeof url !== 'string') return 'Untitled';
  try {
    return new URL(url.trim()).hostname || 'Untitled';
  } catch (e) {
    return 'Untitled';
  }
}
