/**
 * VaultTab Smart Deduplication Engine
 * Detects identical URLs across encrypted workspaces and deduplicates sessions.
 */

import { is_unsaveable_url } from './urls.js';

/**
 * Normalize URL for robust deduplication comparison.
 * Trims trailing slashes, lowercases protocol & host, strips tracking query params (utm_*, ref, etc.).
 *
 * @param {string} url
 * @returns {string}
 */
export function normalize_tab_url(url) {
    if (!url || typeof url !== 'string') return '';
    try {
        const parsed = new URL(url.trim());
        // Clean standard tracking params that differentiate identical pages
        const knownTrackers = new Set(['ref', 'fbclid', 'gclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid', 'msclkid', 'yclid']);
        const keysToDelete = [];
        for (const key of parsed.searchParams.keys()) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.startsWith('utm_') || knownTrackers.has(lowerKey)) {
                keysToDelete.push(key);
            }
        }
        for (const k of keysToDelete) {
            parsed.searchParams.delete(k);
        }
        let clean = parsed.toString();
        // Normalize: remove trailing slashes and dangling query/hash markers
        clean = clean.replace(/\/+$/, '').replace(/[?#]+$/, '');
        return clean;
    } catch (_) {
        return url.trim().toLowerCase().replace(/\/+$/, '').replace(/[?#]+$/, '');
    }
}

/**
 * Scan groups for duplicate tabs.
 *
 * @param {Array<{ id: string, name?: string, tabs: Array<{ url: string, title?: string }> }>} decryptedGroups
 * @returns {{ duplicateCount: number, duplicatesByUrl: Map<string, Array<{ groupId: string, groupName: string, tabIndex: number, title: string, url: string }>> }}
 */
export function scan_for_duplicates(decryptedGroups) {
    if (!Array.isArray(decryptedGroups)) {
        return { duplicateCount: 0, duplicatesByUrl: new Map() };
    }

    const seenUrls = new Map();
    const duplicatesByUrl = new Map();
    let totalDuplicates = 0;

    for (const group of decryptedGroups) {
        if (!group || !Array.isArray(group.tabs)) continue;
        const groupId = group.id || 'unknown';
        const groupName = group.name || 'Unnamed Session';

        for (let idx = 0; idx < group.tabs.length; idx++) {
            const tab = group.tabs[idx];
            if (!tab || !tab.url || is_unsaveable_url(tab.url)) continue;

            const normalized = normalize_tab_url(tab.url);
            const record = {
                groupId,
                groupName,
                tabIndex: idx,
                title: tab.title || tab.url,
                url: tab.url,
                id: tab.id
            };

            if (seenUrls.has(normalized)) {
                if (!duplicatesByUrl.has(normalized)) {
                    duplicatesByUrl.set(normalized, [seenUrls.get(normalized)]);
                }
                duplicatesByUrl.get(normalized).push(record);
                totalDuplicates++;
            } else {
                seenUrls.set(normalized, record);
            }
        }
    }

    return {
        duplicateCount: totalDuplicates,
        duplicatesByUrl
    };
}

/**
 * Deduplicate tabs across groups. Keeps the earliest occurrence of each normalized URL.
 *
 * @param {Array<{ id: string, name?: string, tabs: Array<{ url: string }> }>} decryptedGroups
 * @returns {{ cleanedGroups: Array<object>, removedCount: number }}
 */
export function deduplicate_groups(decryptedGroups) {
    if (!Array.isArray(decryptedGroups)) {
        return { cleanedGroups: [], removedCount: 0 };
    }

    const seen = new Set();
    let removedCount = 0;

    const cleanedGroups = decryptedGroups.map(group => {
        if (!group || !Array.isArray(group.tabs)) return group;

        const uniqueTabs = [];
        for (const tab of group.tabs) {
            if (!tab || !tab.url) continue;
            const norm = normalize_tab_url(tab.url);

            if (seen.has(norm)) {
                removedCount++;
            } else {
                seen.add(norm);
                uniqueTabs.push(tab);
            }
        }

        return {
            ...group,
            tabs: uniqueTabs
        };
    });

    return {
        cleanedGroups,
        removedCount
    };
}
