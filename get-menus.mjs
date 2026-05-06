import { readFileSync } from 'fs';

// Load .env manually
const env = {};
try {
  const lines = readFileSync('.env', 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
} catch {}

const SHOP = (env.SHOP_NAME || env.SHOP || 'sevenfive-4062.myshopify.com').replace(/^https?:\/\//, '');
const TOKEN = env.SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT;
const API_VERSION = '2025-01';

const query = `{
  menus(first: 50) {
    edges {
      node {
        id
        handle
        title
        items {
          id
          title
          url
          type
          items {
            id
            title
            url
            type
            items {
              id
              title
              url
              type
            }
          }
        }
      }
    }
  }
}`;

const response = await fetch(
  `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query }),
  }
);

const data = await response.json();
console.log(JSON.stringify(data, null, 2));
