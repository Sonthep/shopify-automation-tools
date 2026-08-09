---
name: shopify-bulk-scripts
description: >-
  Conventions for writing, editing, or running scripts in the
  shopify-automation-tools repo (bulk_product/, appscript/, scripts/) —
  Shopify Admin GraphQL calls, SKU/variant GID resolution, CSV I/O, and
  which SHOPIFY_ACCESS_TOKEN_* env var to use. Use when adding a new bulk
  update/query script, debugging an existing one, or touching
  shopify_client.py / bulk_product/utils.py.
---

# Shopify Bulk Scripts (this repo)

## Always go through the shared client

Never call `requests.post` to the Shopify API directly. Use:

- `shopify_client.py` → `ShopifyClient(token_env=...).gql(query, variables)` — handles
  throttle retry/backoff and auto-refreshes the token on HTTP 401 via `gen_token.py`.
- Inside `bulk_product/`, use the thin wrappers in `bulk_product/utils.py`
  (`gql`, `make_headers`) instead of re-implementing them — they already delegate
  to `ShopifyClient`.

API version is pinned in both files as `2026-01` — keep them in sync if it ever changes.

## Picking the token env var

`.env` holds multiple tokens for different purposes, not one shared token:

| Env var | Used for |
|---|---|
| `SHOPIFY_ACCESS_TOKEN` | default / general product & inventory scripts |
| `SHOPIFY_ACCESS_TOKEN_CATEGORY` | collections / category updates |
| `SHOPIFY_ACCESS_TOKEN_IMPORT_MENU` | menu import/export |
| `SHOPIFY_ACCESS_TOKEN_IMPORT_PRODUCT` | product import flows |
| `SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT` | creating new products |

Pass the right `token_env` to `ShopifyClient(...)` — don't default to
`SHOPIFY_ACCESS_TOKEN` for everything.

## SKU → GID resolution

Don't query the API per-SKU in a loop. Use `bulk_product/utils.py`:

- `get_product_gids_by_skus(...)` / `get_variant_gids_by_skus(...)` — batches in groups
  of 50 via aliased GraphQL queries.
- Pass `cache_file="bulk_product/cache/product_gids.json"` when one exists so it reads
  from cache instead of hitting the API. Regenerate the cache with
  `bulk_product/reports/fetch_product_gids.py` when it's stale or missing.
- Report any SKU that resolves to `None` back to the user as a `not_found*.csv`
  (existing scripts follow this pattern — keep it consistent).

## CSV handling

- Read CSVs with `read_csv_auto()` from `bulk_product/utils.py` — it tries
  `utf-8-sig` → `cp874` → `latin-1` in order, because source CSVs mix Thai (cp874)
  and UTF-8 exports.
- Pull cell values with `get_val(row, col)`, not `row[col]` directly — it returns
  `None` for a missing column vs `""` for a blank cell, which callers rely on to
  tell "column absent" from "value empty".

## Where new scripts go

- Production scripts live in the relevant `bulk_product/<domain>/` folder
  (`products/`, `collections/`, `metafields/`, `images/`, `pdf/`, `price/`, `reports/`).
- One-off/debug/exploratory scripts go in `bulk_product/dev/` or the top-level
  `scratch/` — do not add throwaway scripts to the domain folders above.
- Bulk Mutation JSONL payloads go in that domain's `output/` folder (e.g.
  `bulk_product/products/output/bulk.jsonl`), matching the naming already there.

## Before committing generated files

`.env`, `bulk_product/cache/`, and most `output/`/`data/` files are gitignored —
don't fight that. A handful of `output/*.jsonl` and `products/output/*.xlsx` files
are already tracked from before the ignore rules existed; don't add *new* generated
files to git even if `git status` shows an existing one as tracked.

## Repo layout notes

- Root `README.md` is kept in sync with the actual folder tree — trust it for current structure.
- PDF sourcing/matching (`Found_PDFs/` → `Web_Ready_PDFs/`) lives in `pdf_sourcing/`, separate
  from `bulk_product/pdf/` which uploads the finished files to Shopify. See
  `pdf_sourcing/README.md` for the pipeline order.
- One-off/debug scripts belong in `bulk_product/dev/` (Shopify-specific) or top-level `scratch/`
  (general) — there is no longer a separate `bulk_product/scratch/`, it was merged into `dev/`.
