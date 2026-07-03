// shared URL helpers for Aegis Tab
// keeps the unsaveable and unrestorable scheme lists in one place
// so popup, background, and manager all use the same definition

// URL schemes that cannot be saved as restorable tabs
const UNSAVEABLE_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'about:',
  'edge:',
  'brave:',
  'devtools:'
];

// check if a URL is a local file path
export function is_local_file_url(url) {
  if (!url) return false;
  return url.startsWith('file://');
}

// check if a URL uses a browser-internal scheme
export function is_unsaveable_url(url) {
  if (!url) return true;
  for (const scheme of UNSAVEABLE_SCHEMES) {
    if (url.startsWith(scheme)) return true;
  }
  return false;
}

// determine the save status of a URL
// returns 'ok', 'unsaveable', or 'local_file'
export function get_url_status(url) {
  if (!url) return 'unsaveable';
  if (is_unsaveable_url(url)) return 'unsaveable';
  if (is_local_file_url(url)) return 'local_file';
  return 'ok';
}

// check if a URL can be restored by chrome.tabs.create
// same as unsaveable check but named for the restore context
export function is_restorable_url(url) {
  return !is_unsaveable_url(url);
}

// derive a display title from a URL
// returns the hostname, or 'Untitled' if the URL is invalid
export function derive_title_from_url(url, fallback_title) {
  if (fallback_title && fallback_title.trim() !== '') return fallback_title;
  if (!url) return 'Untitled';
  try {
    return new URL(url).hostname;
  } catch (e) {
    return 'Untitled';
  }
}
