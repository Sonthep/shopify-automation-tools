// merge_and_update.js
// Usage:
//   node scripts/merge_and_update.js --dry-run
//   node scripts/merge_and_update.js

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

// ─── Config ───────────────────────────────────────────────────────────────────
const SHOP        = process.env.SHOP || process.env.SHOP_NAME || 'sevenfive-4062.myshopify.com';
const TOKEN       = process.env.SHOPIFY_ACCESS_TOKEN_IMPORT_MENU || process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_TOKEN || '';
const MENU_ID     = process.env.MENU_ID || 'gid://shopify/Menu/245262352583';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const MAX_DEPTH   = 3;
const DRY_RUN     = process.argv.includes('--dry-run');

if (!TOKEN) {
  console.error('❌ Missing SHOPIFY_TOKEN env variable');
  console.error('   Usage: SHOPIFY_TOKEN=REDACTED_SHOPIFY_TOKEN node import-menu.js');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toRelativePath(url) {
  if (!url) return '/';
  try {
    return new URL(url, `https://${SHOP}`).pathname || '/';
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

const TYPE_MAP = {
  HTTP: 'HTTP', COLLECTION: 'COLLECTION', PRODUCT: 'PRODUCT',
  PAGE: 'PAGE', BLOG: 'BLOG', ARTICLE: 'ARTICLE',
  SHOP_POLICY: 'SHOP_POLICY', FRONTPAGE: 'FRONTPAGE'
};

function mapType(type) {
  return TYPE_MAP[(type || '').toUpperCase()] || 'HTTP';
}

// ─── CSV Parser (handles quoted fields with commas) ───────────────────────────
function splitCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const values = splitCSVLine(line);
      return headers.reduce((obj, h, i) => {
        obj[h.trim()] = (values[i] ?? '').trim();
        return obj;
      }, {});
    });
}

// ─── GraphQL Client ───────────────────────────────────────────────────────────
async function graphql(query, variables, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': TOKEN
        },
        body: JSON.stringify({ query, variables })
      });

      if (res.status === 429) {
        const wait = 2000 * attempt;
        console.warn(`⏳ Rate limited, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json;

    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`⚠️  Attempt ${attempt} failed: ${err.message}, retrying...`);
      await sleep(1000 * attempt);
    }
  }
}

// ─── Fetch Existing Menu ──────────────────────────────────────────────────────
async function fetchExistingMenu(menuId) {
  const query = `
    query getMenu($id: ID!) {
      menu(id: $id) {
        id title
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
  const res = await graphql(query, { id: menuId });
  return res?.data?.menu;
}

// ─── Convert Existing Item → Input Format ────────────────────────────────────
function existingToInput(item) {
  const input = { title: item.title, type: item.type };
  if (item.resourceId) input.resourceId = item.resourceId;
  else if (item.url)   input.url = item.url;
  if (item.items?.length) input.items = item.items.map(existingToInput);
  return input;
}

// ─── Resource Resolvers ───────────────────────────────────────────────────────
const RESOURCE_QUERIES = {
  COLLECTION: {
    pattern: /\/collections\/([^\/]+)/i,
    query:   `query($handle: String!) { collectionByHandle(handle: $handle) { id } }`,
    extract: d => d?.collectionByHandle?.id
  },
  PRODUCT: {
    pattern: /\/products\/([^\/]+)/i,
    query:   `query($handle: String!) { productByHandle(handle: $handle) { id } }`,
    extract: d => d?.productByHandle?.id
  },
  PAGE: {
    pattern: /\/pages\/([^\/]+)/i,
    query:   `query($handle: String!) { pageByHandle(handle: $handle) { id } }`,
    extract: d => d?.pageByHandle?.id
  },
  BLOG: {
    pattern: /\/blogs\/([^\/]+)/i,
    query:   `query($handle: String!) { blogs(first: 1, query: $handle) { edges { node { id handle } } } }`,
    extract: d => d?.blogs?.edges?.[0]?.node?.id
  }
};

async function resolveResource(item, depth = 0) {
  if (depth > MAX_DEPTH) return item;

  const config = RESOURCE_QUERIES[item.type];

  if (config && item.url) {
    const relativePath = toRelativePath(item.url);
    const match  = relativePath.match(config.pattern);
    const handle = match?.[1];

    if (handle) {
      const res = await graphql(config.query, { handle });
      const id  = config.extract(res?.data);

      if (id) {
        console.log(`    ✅ ${item.type} '${handle}' → ${id}`);
        item.resourceId = id;
        delete item.url;
      } else {
        console.warn(`    ⚠️  ${item.type} not found: '${handle}' → fallback HTTP`);
        item.type = 'HTTP';
        item.url  = relativePath;
      }
    } else {
      item.type = 'HTTP';
      item.url  = toRelativePath(item.url);
    }

  } else if (item.type === 'HTTP' && item.url) {
    item.url = toRelativePath(item.url);
  }

  // Recurse children
  if (item.items?.length) {
    const resolved = [];
    for (const child of item.items) {
      resolved.push(await resolveResource(child, depth + 1));
    }
    item.items = resolved;
  }

  return item;
}

// ─── Build Tree from CSV ──────────────────────────────────────────────────────
async function buildItems(parentTitle, allRows, depth = 0) {
  if (depth > MAX_DEPTH) return [];

  const children = allRows.filter(r =>
    (r['Parent Menu Item Title'] || '') === parentTitle
  );

  const items = [];
  for (const r of children) {
    const item = {
      title: r['Menu Item Title'],
      type:  mapType(r['Menu Item Type']),
      url:   r['Menu Item URL'] || undefined,
      items: await buildItems(r['Menu Item Title'], allRows, depth + 1)
    };
    items.push(await resolveResource(item, depth));
  }
  return items;
}

// ─── Clean empty items arrays ─────────────────────────────────────────────────
function cleanItems(items) {
  return items.map(item => {
    const cleaned = { ...item };
    if (cleaned.items?.length) cleaned.items = cleanItems(cleaned.items);
    else delete cleaned.items;
    return cleaned;
  });
}

// ─── Merge: existing + new (by title, case-insensitive) ──────────────────────
function mergeItems(existingItems, newItems) {
  const result = existingItems.map(existingToInput);

  for (const newItem of newItems) {
    const matchIdx = result.findIndex(
      e => e.title.toLowerCase() === newItem.title.toLowerCase()
    );

    if (matchIdx !== -1) {
      // title ซ้ำ → merge children เท่านั้น, คง parent เดิม
      console.log(`  🔄 Merge children of: "${newItem.title}"`);
      const existingChildren = result[matchIdx].items || [];
      const newChildren      = newItem.items || [];
      result[matchIdx].items = mergeItems(existingChildren, newChildren);
      if (!result[matchIdx].items.length) delete result[matchIdx].items;
    } else {
      // ใหม่ → append
      console.log(`  ➕ Append new item: "${newItem.title}"`);
      result.push(newItem);
    }
  }

  return result;
}

// ─── Print Tree ───────────────────────────────────────────────────────────────
function printTree(items, indent = '') {
  for (const item of items) {
    const target = item.resourceId ? `resourceId: ${item.resourceId}` : `url: ${item.url}`;
    console.log(`${indent}├─ [${item.type}] "${item.title}" (${target})`);
    if (item.items?.length) printTree(item.items, indent + '│  ');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function importMenu() {
  console.log('═'.repeat(60));
  console.log(`🚀 Menu Import${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('═'.repeat(60));

  // 1. ดึง menu เดิม
  console.log('\n📥 Fetching existing menu...');
  const existingMenu = await fetchExistingMenu(MENU_ID);
  if (!existingMenu) {
    console.error('❌ Menu not found — check MENU_ID');
    process.exit(1);
  }
  console.log(`   "${existingMenu.title}" — ${existingMenu.items.length} top-level items`);
  console.log(`   Existing: ${existingMenu.items.map(i => i.title).join(', ')}`);

  // 2. อ่าน CSV
  if (!fs.existsSync('update-cat-sp.csv')) {
    console.error('❌ update-cat-sp.csv not found');
    process.exit(1);
  }
  const csv  = fs.readFileSync('update-cat-sp.csv', 'utf8');
  const rows = parseCSV(csv);
  console.log(`\n📄 CSV: ${rows.length} rows loaded`);

  // 3. Build items จาก CSV
  console.log('\n🔍 Resolving resources from CSV...');
  const rawItems = await buildItems('', rows);
  const newItems = cleanItems(rawItems);

  // 4. Merge
  console.log('\n🔀 Merging with existing menu...');
  const mergedItems = mergeItems(existingMenu.items, newItems);

  // 5. Preview
  console.log('\n📋 Final menu structure:');
  printTree(mergedItems);

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete — no changes made');
    console.log('   Run without --dry-run to apply changes');
    return;
  }

  // 6. ส่ง update
  const mutation = `
    mutation menuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, items: $items) {
        menu {
          id title
          items { id title type url
            items { id title type url }
          }
        }
        userErrors { field message }
      }
    }
  `;

  console.log('\n📤 Sending update to Shopify...');
  const result = await graphql(mutation, {
    id:    MENU_ID,
    title: existingMenu.title,
    items: mergedItems
  });

  const { menu, userErrors } = result?.data?.menuUpdate ?? {};

  if (userErrors?.length) {
    console.error('\n❌ Errors:');
    userErrors.forEach(e => console.error(`   [${e.field}] ${e.message}`));
    process.exit(1);
  }

  console.log(`\n✅ Done! Menu "${menu?.title}" updated`);
  console.log(`   Top-level items: ${menu?.items?.map(i => i.title).join(', ')}`);
  console.log('═'.repeat(60));
}

importMenu().catch(err => {
  console.error('\n💥 Fatal:', err.message);
  process.exit(1);
});
