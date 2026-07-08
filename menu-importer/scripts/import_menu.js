const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

// Read configuration from environment (with sensible fallbacks)
const SHOP = process.env.SHOP || process.env.SHOP_NAME || 'sevenfive-4062.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN_IMPORT_MENU || process.env.SHOPIFY_ACCESS_TOKEN || '';
const MENU_ID = process.env.MENU_ID || 'gid://shopify/Menu/245262352583';

const csv = fs.readFileSync(path.resolve(__dirname, '../data/import_menu.csv'), 'utf8');
const lines = csv.trim().split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).map(line => {
  const values = line.split(',');
  return headers.reduce((obj, header, i) => {
    obj[header.trim()] = values[i]?.trim() || '';
    return obj;
  }, {});
});

async function graphql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

function mapType(type) {
  const map = {
    'HTTP': 'HTTP',
    'COLLECTION': 'COLLECTION',
    'PRODUCT': 'PRODUCT',
    'PAGE': 'PAGE',
    'BLOG': 'BLOG',
    'ARTICLE': 'ARTICLE',
    'SHOP_POLICY': 'SHOP_POLICY',
    'FRONTPAGE': 'FRONTPAGE'
  };
  return map[type.toUpperCase()] || 'HTTP';
}

// แยก relative path จาก URL (ทั้ง absolute และ relative)
function toRelativePath(url) {
  if (!url) return '/';
  try {
    const pathname = new URL(url, `https://${SHOP}`).pathname;
    return pathname || '/';
  } catch (e) {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

async function resolveResource(item) {
  const originalUrl = item.url;

  if (item.type === 'COLLECTION' && originalUrl) {
    const relativePath = toRelativePath(originalUrl);
    const m = relativePath.match(/\/collections\/([^\/]+)/i);
    const handle = m && m[1];

    if (handle) {
      // ลองหา collection จาก handle ก่อน
      const query = `query collectionByHandle($handle: String!) { collectionByHandle(handle: $handle) { id } }`;
      const res = await graphql(query, { handle });
      const id = res?.data?.collectionByHandle?.id;

      if (id) {
        // ✅ เจอ collection → ใช้ resourceId
        console.log(`✅ Collection found: '${handle}' → ${id}`);
        item.resourceId = id;
        delete item.url;
      } else {
        // ❌ ไม่เจอ → fallback เป็น HTTP + relative URL (ไม่ create)
        console.warn(`⚠️  Collection not found for handle '${handle}', falling back to HTTP: ${relativePath}`);
        item.type = 'HTTP';
        item.url = relativePath;
      }
    } else {
      // URL ไม่มี /collections/ → fallback HTTP
      item.type = 'HTTP';
      item.url = relativePath;
    }
  } else if (item.type === 'PRODUCT' && originalUrl) {
    const relativePath = toRelativePath(originalUrl);
    const m = relativePath.match(/\/products\/([^\/]+)/i);
    const handle = m && m[1];

    if (handle) {
      const query = `query productByHandle($handle: String!) { productByHandle(handle: $handle) { id } }`;
      const res = await graphql(query, { handle });
      const id = res?.data?.productByHandle?.id;

      if (id) {
        console.log(`✅ Product found: '${handle}' → ${id}`);
        item.resourceId = id;
        delete item.url;
      } else {
        console.warn(`⚠️  Product not found for handle '${handle}', falling back to HTTP: ${relativePath}`);
        item.type = 'HTTP';
        item.url = relativePath;
      }
    }
  } else if (item.type === 'HTTP' && originalUrl) {
    // แปลง absolute URL → relative เสมอ
    item.url = toRelativePath(originalUrl);
  }

  // Recurse children
  if (Array.isArray(item.items) && item.items.length) {
    const resolved = [];
    for (const child of item.items) resolved.push(await resolveResource(child));
    item.items = resolved;
  }

  return item;
}

async function buildItems(parentTitle, allRows) {
  const items = allRows
    .filter(r => (r['Parent Menu Item Title'] || '') === parentTitle)
    .map(r => ({
      title: r['Menu Item Title'],
      type: mapType(r['Menu Item Type']),
      url: r['Menu Item URL'],
      items: []
    }));

  for (const it of items) {
    it.items = await buildItems(it.title, allRows);
  }

  const resolved = [];
  for (const it of items) resolved.push(await resolveResource(it));
  return resolved;
}

async function importMenu() {
  const items = await buildItems('', rows);
  console.log('Structure:', JSON.stringify(items, null, 2));

  const mutation = `
    mutation menuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, items: $items) {
        menu { id title items { id title } }
        userErrors { field message }
      }
    }
  `;

  const result = await graphql(mutation, {
    id: MENU_ID,
    title: 'Main menu',
    items: items
  });

  console.log(JSON.stringify(result, null, 2));
}

importMenu().catch(console.error);
