import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitize_group_color,
    serialize_tabs_with_groups,
    plan_group_reconstruction,
    apply_group_reconstruction
} from '../common/tab_groups.js';

test('TAB GROUPS: Color validation and sanitization', () => {
    assert.equal(sanitize_group_color('red'), 'red');
    assert.equal(sanitize_group_color('CYAN'), 'cyan');
    assert.equal(sanitize_group_color('  purple  '), 'purple');
    assert.equal(sanitize_group_color('neon-green'), 'blue', 'Invalid color defaults to blue');
    assert.equal(sanitize_group_color(null), 'blue');
    assert.equal(sanitize_group_color(undefined), 'blue');
});

test('TAB GROUPS: Serialization maps native groups correctly', () => {
    const rawTabs = [
        { id: 1, url: 'https://github.com', title: 'GitHub', groupId: 10, pinned: true },
        { id: 2, url: 'https://rust-lang.org', title: 'Rust', groupId: 10, pinned: false },
        { id: 3, url: 'https://google.com', title: 'Google', groupId: -1, pinned: false },
        { id: 4, url: 'https://audit.io', title: 'Audit', groupId: 20, pinned: false }
    ];

    const rawGroups = [
        { id: 10, title: 'Dev Stack', color: 'green', collapsed: false },
        { id: 20, title: 'Security Audit', color: 'red', collapsed: true }
    ];

    const result = serialize_tabs_with_groups(rawTabs, rawGroups);

    assert.equal(result.tabs.length, 4);
    assert.equal(result.tabs[0].group_key, 'Dev Stack');
    assert.equal(result.tabs[0].pinned, true);
    assert.equal(result.tabs[1].group_key, 'Dev Stack');
    assert.equal(result.tabs[2].group_key, undefined, 'Ungrouped tab has no group key');
    assert.equal(result.tabs[3].group_key, 'Security Audit');

    assert.deepEqual(result.native_groups['Dev Stack'], {
        title: 'Dev Stack',
        color: 'green',
        collapsed: false
    });
    assert.deepEqual(result.native_groups['Security Audit'], {
        title: 'Security Audit',
        color: 'red',
        collapsed: true
    });
});

test('TAB GROUPS: Reconstruction planner generates correct grouping instructions', () => {
    const openedTabs = [
        { id: 101, url: 'https://github.com', group_key: 'Dev Stack' },
        { id: 102, url: 'https://rust-lang.org', group_key: 'Dev Stack' },
        { id: 103, url: 'https://google.com' }, // ungrouped
        { id: 104, url: 'https://audit.io', group_key: 'Security Audit' }
    ];

    const nativeGroups = {
        'Dev Stack': { title: 'Dev Stack', color: 'green', collapsed: false },
        'Security Audit': { title: 'Security Audit', color: 'red', collapsed: true }
    };

    const plan = plan_group_reconstruction(openedTabs, nativeGroups);

    assert.equal(plan.length, 2);
    assert.deepEqual(plan[0].tabIds, [101, 102]);
    assert.equal(plan[0].metadata.title, 'Dev Stack');
    assert.equal(plan[0].metadata.color, 'green');

    assert.deepEqual(plan[1].tabIds, [104]);
    assert.equal(plan[1].metadata.title, 'Security Audit');
    assert.equal(plan[1].metadata.color, 'red');
    assert.equal(plan[1].metadata.collapsed, true);
});

test('TAB GROUPS: apply_group_reconstruction interacts with chrome API cleanly', async () => {
    const groupedCalls = [];
    const updateCalls = [];

    const mockChrome = {
        tabs: {
            group: async ({ tabIds }) => {
                groupedCalls.push(tabIds);
                return 999;
            }
        },
        tabGroups: {
            update: async (groupId, options) => {
                updateCalls.push({ groupId, options });
                return { id: groupId, ...options };
            }
        }
    };

    const plan = [
        {
            tabIds: [11, 12],
            metadata: { title: 'Work', color: 'purple', collapsed: false }
        }
    ];

    const groupIds = await apply_group_reconstruction(mockChrome, plan);

    assert.deepEqual(groupIds, [999]);
    assert.deepEqual(groupedCalls, [[11, 12]]);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].groupId, 999);
    assert.equal(updateCalls[0].options.title, 'Work');
    assert.equal(updateCalls[0].options.color, 'purple');
});
