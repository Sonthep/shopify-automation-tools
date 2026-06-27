"""
Run once to build a local SKU→GID cache (product_gids.json).
After running, all other scripts can pass cache_file="product_gids.json"
to get_product_gids_by_skus() and skip the API lookup entirely.

Usage:
    py fetch_product_gids.py
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import json
import os
from utils import make_headers, gql, API_URL

HEADERS     = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "cache", "product_gids.json")

QUERY = """
query getProducts($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      variants(first: 100) {
        nodes { sku }
      }
    }
  }
}
"""


def fetch_all_product_gids() -> dict:
    sku_map: dict[str, str] = {}
    cursor = None

    while True:
        body = gql(API_URL, HEADERS, QUERY, {"cursor": cursor})
        if not body:
            break
        data = body["data"]["products"]

        for product in data["nodes"]:
            gid = product["id"]
            for variant in product["variants"]["nodes"]:
                sku = (variant.get("sku") or "").strip()
                if sku:
                    sku_map[sku] = gid

        print(f"  Fetched {len(sku_map)} SKUs so far...")

        if not data["pageInfo"]["hasNextPage"]:
            break
        cursor = data["pageInfo"]["endCursor"]

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(sku_map, f, ensure_ascii=False, indent=2)

    print(f"✅ Saved {len(sku_map)} SKU→GID mappings to {OUTPUT_FILE}")
    return sku_map


if __name__ == "__main__":
    fetch_all_product_gids()
