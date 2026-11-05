/**
 * VaultTab Multi-Format Exporter
 * Exports encrypted workspaces to Markdown, Netscape HTML Bookmarks, CSV, and JSON.
 */

/**
 * Escape text for HTML attributes and contents.
 */
function escape_html(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Format session tabs as clean GitHub-Flavored Markdown.
 * Perfect for Obsidian, Notion, Roam, and research documentation.
 *
 * @param {object} group - { name, date, tabs: Array<{ url, title, status }> }
 * @returns {string} Markdown document
 */
export function format_as_markdown(group) {
    const title = group.name || 'VaultTab Session';
    const dateStr = group.date ? new Date(group.date).toLocaleString() : new Date().toLocaleString();
    const tabs = Array.isArray(group.tabs) ? group.tabs : [];

    let md = `# ${title}\n\n`;
    md += `> **Saved on:** ${dateStr}  \n`;
    md += `> **Total Tabs:** ${tabs.length}\n\n`;
    md += `## Saved Tabs\n\n`;

    if (tabs.length === 0) {
        md += `*No tabs in this session.*\n`;
        return md;
    }

    tabs.forEach((tab, idx) => {
        const rawTitle = (tab.title || tab.url || 'Untitled').replace(/[\r\n]+/g, ' ').trim();
        const tabTitle = rawTitle.replace(/\]/g, '\\]').replace(/\[/g, '\\[');
        const url = (tab.url || '').trim();
        const formattedUrl = /[ ()]/.test(url) ? `<${url}>` : url;
        md += `${idx + 1}. [${tabTitle}](${formattedUrl})\n`;
    });

    md += `\n---\n*Exported securely via [VaultTab](https://saman-ghorayshi.github.io/vault-tab/)*\n`;
    return md;
}

/**
 * Format session tabs into standard Netscape Bookmark File format (HTML).
 * Universally supported by Google Chrome, Brave, Edge, Safari, and Firefox.
 *
 * @param {object} group - { name, date, tabs: Array<{ url, title }> }
 * @returns {string} Netscape HTML Bookmarks file
 */
export function format_as_html_bookmarks(group) {
    const title = group.name || 'VaultTab Export';
    const timestamp = Math.floor(new Date(group.date || Date.now()).getTime() / 1000);
    const tabs = Array.isArray(group.tabs) ? group.tabs : [];

    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${timestamp}" LAST_MODIFIED="${timestamp}">${escape_html(title)}</H3>
    <DL><p>
`;

    for (const tab of tabs) {
        const url = escape_html(tab.url || '');
        const tabTitle = escape_html(tab.title || tab.url || 'Untitled');
        const icon = tab.fav_icon_url && tab.fav_icon_url.startsWith('data:image/') ? ` ICON="${escape_html(tab.fav_icon_url)}"` : '';
        html += `        <DT><A HREF="${url}" ADD_DATE="${timestamp}"${icon}>${tabTitle}</A>\n`;
    }

    html += `    </DL><p>
</DL><p>
`;
    return html;
}

/**
 * Sanitize cell values against formula injection (CWE-1236).
 * Prepends a single quote if the string begins with =, +, -, @, tab, or carriage return.
 */
function sanitize_csv_cell(val) {
    let str = (val === null || val === undefined ? '' : String(val)).replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    return str;
}

/**
 * Format session tabs into CSV format.
 *
 * @param {object} group
 * @returns {string} CSV text
 */
export function format_as_csv(group) {
    const groupName = sanitize_csv_cell(group.name || 'Session');
    const tabs = Array.isArray(group.tabs) ? group.tabs : [];

    let csv = `"Index","Title","URL","SessionName","Date"\n`;
    tabs.forEach((tab, idx) => {
        const title = sanitize_csv_cell(tab.title || '');
        const url = sanitize_csv_cell(tab.url || '');
        const date = sanitize_csv_cell(group.date || '');
        csv += `"${idx + 1}","${title}","${url}","${groupName}","${date}"\n`;
    });

    return csv;
}
