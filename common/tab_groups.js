/**
 * Chromium Tab Groups Persona Swapper
 * Preserves native tab group colors, titles, and collapsed states
 * across Zero-Knowledge encrypted backups, restorations, and persona swaps.
 */

export const VALID_CHROMIUM_GROUP_COLORS = [
    'grey',
    'blue',
    'red',
    'yellow',
    'green',
    'pink',
    'purple',
    'cyan',
    'orange'
];

/**
 * Normalize and validate a tab group color. Defaults to 'blue'.
 * @param {string} color
 * @returns {string}
 */
export function sanitize_group_color(color) {
    if (!color || typeof color !== 'string') return 'blue';
    const c = color.trim().toLowerCase();
    return VALID_CHROMIUM_GROUP_COLORS.includes(c) ? c : 'blue';
}

/**
 * Capture and map native Chromium tab group definitions from current window tabs.
 *
 * @param {Array<object>} tabs - Raw chrome.tabs.Tab objects
 * @param {Array<object>} [groups=[]] - Raw chrome.tabGroups.TabGroup objects
 * @returns {{ tabs: Array<object>, native_groups: object }}
 */
export function serialize_tabs_with_groups(tabs, groups = []) {
    if (!Array.isArray(tabs)) return { tabs: [], native_groups: {} };

    const groupMap = {};
    if (Array.isArray(groups)) {
        for (const g of groups) {
            if (g && g.id !== undefined && g.id !== -1) {
                groupMap[g.id] = {
                    title: typeof g.title === 'string' ? g.title.trim() : '',
                    color: sanitize_group_color(g.color),
                    collapsed: Boolean(g.collapsed)
                };
            }
        }
    }

    const native_groups = {};
    const serializedTabs = tabs.map(tab => {
        const item = {
            url: tab.url,
            title: tab.title || tab.url,
            fav_icon_url: tab.favIconUrl || tab.fav_icon_url || '',
            pinned: Boolean(tab.pinned)
        };

        if (tab.groupId !== undefined && tab.groupId !== -1 && groupMap[tab.groupId]) {
            const meta = groupMap[tab.groupId];
            const groupKey = meta.title || `group_${tab.groupId}`;
            item.group_key = groupKey;

            if (!native_groups[groupKey]) {
                native_groups[groupKey] = {
                    title: meta.title,
                    color: meta.color,
                    collapsed: meta.collapsed
                };
            }
        }

        return item;
    });

    return {
        tabs: serializedTabs,
        native_groups
    };
}

/**
 * Create a reconstruction plan for restoring tab groups from opened tabs.
 *
 * @param {Array<{ id: number, group_key?: string }>} openedTabs
 * @param {object} nativeGroups - Map of groupKey -> { title, color, collapsed }
 * @returns {Array<{ tabIds: Array<number>, metadata: { title: string, color: string, collapsed: boolean } }>}
 */
export function plan_group_reconstruction(openedTabs, nativeGroups = {}) {
    if (!Array.isArray(openedTabs) || !nativeGroups || typeof nativeGroups !== 'object') {
        return [];
    }

    const buckets = {};
    for (const tab of openedTabs) {
        if (tab && tab.id && tab.group_key && nativeGroups[tab.group_key]) {
            if (!buckets[tab.group_key]) {
                buckets[tab.group_key] = [];
            }
            buckets[tab.group_key].push(tab.id);
        }
    }

    const plan = [];
    for (const [groupKey, tabIds] of Object.entries(buckets)) {
        if (tabIds.length > 0) {
            const meta = nativeGroups[groupKey];
            plan.push({
                tabIds,
                metadata: {
                    title: meta.title || '',
                    color: sanitize_group_color(meta.color),
                    collapsed: Boolean(meta.collapsed)
                }
            });
        }
    }

    return plan;
}

/**
 * Apply reconstruction plan using the native chrome.tabs.group and chrome.tabGroups.update APIs.
 *
 * @param {object} chromeApi - Reference to chrome object
 * @param {Array<object>} plan - Reconstruction plan from plan_group_reconstruction
 * @returns {Promise<Array<number>>} Created group IDs
 */
export async function apply_group_reconstruction(chromeApi, plan) {
    if (!chromeApi || !chromeApi.tabs || !chromeApi.tabs.group || !chromeApi.tabGroups) {
        return [];
    }

    const createdGroupIds = [];
    for (const item of plan) {
        try {
            const groupId = await chromeApi.tabs.group({ tabIds: item.tabIds });
            await chromeApi.tabGroups.update(groupId, {
                title: item.metadata.title,
                color: item.metadata.color,
                collapsed: item.metadata.collapsed
            });
            createdGroupIds.push(groupId);
        } catch (e) {
            console.warn('Failed to group restored tabs:', e);
        }
    }

    return createdGroupIds;
}
