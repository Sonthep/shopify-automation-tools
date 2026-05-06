import { readFileSync, writeFileSync } from 'fs';

const inputPath = 'menus-output.json';
const outputPath = 'menus-output.csv';

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
const edges = source?.data?.menus?.edges ?? [];

const rows = [];

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function visitItems(menu, items, level, parentTitle, parentPath) {
  for (const item of items ?? []) {
    const currentPath = parentPath ? `${parentPath} > ${item.title}` : item.title;
    rows.push({
      menu_id: menu.id,
      menu_handle: menu.handle,
      menu_title: menu.title,
      level,
      parent_title: parentTitle,
      item_id: item.id ?? '',
      item_title: item.title ?? '',
      item_type: item.type ?? '',
      item_url: item.url ?? '',
      item_path: currentPath,
    });

    visitItems(menu, item.items, level + 1, item.title ?? '', currentPath);
  }
}

for (const edge of edges) {
  const menu = edge.node;
  visitItems(menu, menu.items, 1, '', '');
}

const header = [
  'menu_id',
  'menu_handle',
  'menu_title',
  'level',
  'parent_title',
  'item_id',
  'item_title',
  'item_type',
  'item_url',
  'item_path',
];

const csv = [
  header.join(','),
  ...rows.map((row) => header.map((key) => escapeCsv(row[key])).join(',')),
].join('\n');

writeFileSync(outputPath, csv, 'utf8');

console.log(`Wrote ${rows.length} rows to ${outputPath}`);