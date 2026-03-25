# create-collection

Small script to create Shopify smart collections from a CSV list of vendor names and image URLs.

## What this does
- Read `image logo.csv` (CSV in the same folder) with columns `Brand Name` and `link image`.
- For each row it creates a Shopify Smart Collection (GraphQL) with rule `VENDOR = <Brand Name>`.
- If an image URL is provided it will attach that image to the collection (or use a local `vendor-images/<Brand Name>.jpg` fallback).

## Files
- `create-collections.js` — main script
- `image logo.csv` — your CSV (not committed) / see sample below
- `vendor-images/` — optional folder with local JPGs named exactly as the Brand Name

## CSV format example
Create `create-collection/image logo.csv` with header exactly:

```csv
Brand Name,link image
IWATANI,https://example.com/iwatani.jpg
NORDWAYS,https://example.com/nordways.jpg
HOBART,
```

If `link image` is empty the script will try `vendor-images/<Brand Name>.jpg`.

## Setup
1. Install dependencies (from repo root):

```bash
npm install node-fetch@2 csv-parser
# optionally install dotenv if you want to use a .env file
npm install dotenv
```

2. Do NOT store your Shopify token in code. Provide it via environment variable:

- `SHOP_NAME` — your shop (default in script if omitted)
- `SHOPIFY_ACCESS_TOKEN` — your Admin API token

You can create a `.env` file in the `create-collection/` folder (optional):

```
SHOP_NAME=sevenfive-4062
SHOPIFY_ACCESS_TOKEN=REDACTED_SHOPIFY_TOKEN
```

## Run
From the `create-collection/` folder:

```bash
node create-collections.js
```

## Notes / Best practices
- Keep your admin token secret; do not commit `.env` or tokens.
- The script waits between requests to avoid rate limits — adjust delays if necessary.
- Test with a small subset first.
- The script expects the CSV header names exactly as shown.

## Troubleshooting
- If you get permission errors, verify the Admin API token scopes include `write_collections` and `read_products`.
- If GraphQL returns userErrors, inspect the `userErrors` printed to console.

