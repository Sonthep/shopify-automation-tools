// ต้องติดตั้ง: npm install node-fetch@2
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (e) { /* optional */ }

const SHOP_NAME = process.env.SHOP_NAME || 'sevenfive-4062';
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';

if (!ACCESS_TOKEN) {
  console.error('ACCESS_TOKEN is empty. Set SHOPIFY_ACCESS_TOKEN in your environment.');
  process.exit(1);
}

async function fetchProducts() {
  const products = [];
  let hasNext = true;
  let cursor = null;

  while (hasNext) {
    const afterClause = cursor ? `, after: \"${cursor}\"` : '';
    const query = `
      {
        products(first: 100${afterClause}) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              title
              vendor
              handle
              descriptionHtml
              onlineStoreUrl
              images(first: 1) { edges { node { url } } }
              variants(first: 10) { edges { node { id sku price } } }
            }
          }
        }
      }
    `;

    const res = await fetch(`https://${SHOP_NAME}.myshopify.com/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN
      },
      body: JSON.stringify({ query })
    });

    // helpful debug: show HTTP status if non-2xx
    if (!res.ok) {
      const text = await res.text();
      console.error('HTTP error', res.status, text);
      break;
    }

    const json = await res.json();
    if (json.errors) {
      console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
      break;
    }

    const data = json.data && json.data.products;
    if (!data) {
      console.error('Unexpected response (no data.products):', JSON.stringify(json, null, 2));
      break;
    }

    for (const edge of data.edges) {
      products.push(edge.node);
      cursor = edge.cursor;
    }

    hasNext = data.pageInfo.hasNextPage;
  }

  const outPath = path.join(__dirname, 'products.json');
  fs.writeFileSync(outPath, JSON.stringify(products, null, 2), 'utf8');
  console.log(`Saved ${products.length} product(s) to ${outPath}`);
}

fetchProducts().catch(err => {
  console.error('Fetch failed:', err && err.message ? err.message : err);
  process.exit(1);
});
