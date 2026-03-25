const fetch = globalThis.fetch || require('node-fetch');
require('dotenv').config();

const SHOP = process.env.SHOP || process.env.SHOP_NAME || 'sevenfive-4062.myshopify.com';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN_IMPORT_MENU || process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_TOKEN || '';
const MENU_ID = process.env.MENU_ID || 'gid://shopify/Menu/245262352583';

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

async function fetchMenu() {
  const query = `
    query getMenu($id: ID!) {
      menu(id: $id) {
        id
        title
        items {
          id
          title
          type
          url
          items {
            id
            title
            type
            url
            items { id title type url }
          }
        }
      }
    }
  `;

  const res = await graphql(query, { id: MENU_ID });
  console.log(JSON.stringify(res, null, 2));
}

fetchMenu().catch(err => { console.error(err); process.exit(1); });
