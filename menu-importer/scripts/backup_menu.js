// backup_menu.js
// Usage: node scripts/backup_menu.js (from menu-importer/ root)
const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const SHOP    = process.env.SHOP || process.env.SHOP_NAME || 'sevenfive-4062.myshopify.com';
const TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN_IMPORT_MENU || process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_TOKEN || '';
const MENU_ID = process.env.MENU_ID || 'gid://shopify/Menu/245262352583';
const API_VER = process.env.SHOPIFY_API_VERSION || '2025-01';

async function graphql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VER}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function backupMenu() {
  const query = `
    query getMenu($id: ID!) {
      menu(id: $id) {
        id title handle
        items {
          id title type url resourceId
          items {
            id title type url resourceId
            items {
              id title type url resourceId
            }
          }
        }
      }
    }
  `;

  const res = await graphql(query, { id: MENU_ID });
  const menu = res?.data?.menu;

  if (!menu) {
    console.error('❌ Menu not found');
    process.exit(1);
  }

  // Save JSON backup → backups/
  const backupsDir = path.resolve(__dirname, '../backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(backupsDir, `menu-backup-${timestamp}.json`);
  fs.writeFileSync(filename, JSON.stringify(menu, null, 2));
  console.log(`✅ Backup saved: ${filename}`);

  const csvFilename = path.join(backupsDir, `menu-backup-${timestamp}.csv`);
  const csvLines = ['Parent Menu Item Title,Menu Item Title,Menu Item Type,Menu Item URL'];

  function itemsToCSV(items, parentTitle = '') {
    for (const item of items) {
      const url = item.url || '';
      csvLines.push(`${parentTitle},${item.title},${item.type},${url}`);
      if (item.items?.length) itemsToCSV(item.items, item.title);
    }
  }

  itemsToCSV(menu.items);
  fs.writeFileSync(csvFilename, csvLines.join('\n'));
  console.log(`✅ CSV backup saved: ${csvFilename}`);

  // Print summary
  console.log(`\n📋 Menu: "${menu.title}"`);
  console.log(`   Items: ${menu.items.map(i => i.title).join(', ')}`);
}

backupMenu().catch(err => {
  console.error('💥', err.message);
  process.exit(1);
});
