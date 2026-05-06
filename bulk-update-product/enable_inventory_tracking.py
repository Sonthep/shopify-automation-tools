"""
Enable inventory tracking (inventoryManagement = SHOPIFY) for ALL product variants.

After running this script, quantityAvailable will return a real number instead of null
on the storefront, so "Stock: -" will no longer appear.

Usage:
    py enable_inventory_tracking.py             # dry-run (preview only)
    py enable_inventory_tracking.py --apply     # actually update Shopify
"""
import argparse
import time
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# ── Fetch all variants ────────────────────────────────────────────────────────

FETCH_QUERY = """
query getVariants($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      inventoryManagement
      product { title }
    }
  }
}
"""

# ── Update a single variant ───────────────────────────────────────────────────

UPDATE_MUTATION = """
mutation enableTracking($input: ProductVariantInput!) {
  productVariantUpdate(input: $input) {
    productVariant {
      id
      inventoryManagement
    }
    userErrors {
      field
      message
    }
  }
}
"""


def fetch_all_variants() -> list[dict]:
    """Return all product variants from Shopify."""
    variants: list[dict] = []
    cursor = None

    while True:
        body = gql(API_URL, HEADERS, FETCH_QUERY, {"cursor": cursor})
        if not body:
            print("[ERR] Failed to fetch variants.")
            break

        data = body["data"]["productVariants"]
        batch = data["nodes"]
        variants.extend(batch)
        print(f"  Fetched {len(variants)} variants so far...")

        if not data["pageInfo"]["hasNextPage"]:
            break
        cursor = data["pageInfo"]["endCursor"]

    return variants


def enable_tracking(variants: list[dict], apply: bool) -> None:
    """Enable inventory tracking on variants that currently have it disabled."""
    to_update = [v for v in variants if v["inventoryManagement"] != "SHOPIFY"]

    print(f"\nTotal variants     : {len(variants)}")
    print(f"Need tracking      : {len(to_update)}")
    print(f"Already tracked    : {len(variants) - len(to_update)}")

    if not to_update:
        print("\n✅ All variants already have inventory tracking enabled.")
        return

    if not apply:
        print("\n[DRY-RUN] The following variants would be updated (run with --apply to apply):")
        for v in to_update[:20]:
            print(f"  {v['product']['title']!r:50s}  SKU={v['sku'] or '(none)':30s}  id={v['id']}")
        if len(to_update) > 20:
            print(f"  ... and {len(to_update) - 20} more")
        return

    # --- Apply ---
    success = 0
    failed  = 0

    for i, variant in enumerate(to_update, 1):
        body = gql(API_URL, HEADERS, UPDATE_MUTATION, {
            "input": {
                "id": variant["id"],
                "inventoryManagement": "SHOPIFY",
            }
        })

        if not body:
            print(f"  [{i}/{len(to_update)}] FAIL (no response)  {variant['id']}")
            failed += 1
            continue

        errors = body["data"]["productVariantUpdate"]["userErrors"]
        if errors:
            print(f"  [{i}/{len(to_update)}] ERROR  {variant['id']} — {errors}")
            failed += 1
        else:
            sku = variant["sku"] or "(no sku)"
            print(f"  [{i}/{len(to_update)}] OK  {variant['product']['title']!r}  SKU={sku}")
            success += 1

        # Throttle: ~2 req/s to stay under Shopify rate limits
        if i % 10 == 0:
            time.sleep(1)

    print(f"\n✅ Done — success: {success}  failed: {failed}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Enable Shopify inventory tracking on all variants.")
    parser.add_argument("--apply", action="store_true", help="Actually update Shopify (default is dry-run).")
    args = parser.parse_args()

    print("Fetching all product variants...")
    variants = fetch_all_variants()
    enable_tracking(variants, apply=args.apply)


if __name__ == "__main__":
    main()
