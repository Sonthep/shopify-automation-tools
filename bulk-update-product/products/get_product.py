"""
Export ALL Shopify products to Excel via Bulk Operation API.

Fetches: id, handle, title, descriptionHtml, vendor, productType, tags,
         status, publishedAt, seo, category,
         variants (sku, price, compareAtPrice, inventoryItem.id),
         first image, metafields (namespace + key + value)

Usage:
    py get_product.py
    py get_product.py --out output/products.xlsx
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))


import argparse
import json
import os
import sys
import time
from collections import defaultdict

import pandas as pd
import requests

from utils import make_headers, gql, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

# ── Step 1: Start bulk query ──────────────────────────────────

# Inner query passed as variable — avoids triple-quote escaping issues
INNER_QUERY = """
{
  products {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        vendor
        productType
        tags
        status
        publishedAt
        seo { title description }
        category { name fullName }
        variants {
          edges {
            node {
              id
              sku
              price
              compareAtPrice
              inventoryQuantity
              inventoryItem { id }
            }
          }
        }
        featuredImage { url }
        metafields {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  }
}
"""

BULK_MUTATION = """
mutation BulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
"""

def start_bulk_query() -> str | None:
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"query": INNER_QUERY})
    if not body:
        return None
    op_data = body["data"]["bulkOperationRunQuery"]
    if op_data.get("userErrors"):
        print(f"[ERROR] {op_data['userErrors']}")
        return None
    op_id = op_data["bulkOperation"]["id"]
    print(f"Bulk operation started: {op_id}")
    return op_id


# ── Step 2: Poll until COMPLETED ─────────────────────────────

POLL_QUERY = "{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }"

def poll_status(interval: int = 10) -> str | None:
    while True:
        body = gql(API_URL, HEADERS, POLL_QUERY)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print("[ERROR] No active bulk operation.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} objects")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[ERROR] {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Step 3: Download & parse JSONL ───────────────────────────

def download_jsonl(url: str) -> list[dict]:
    print(f"Downloading result...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} lines downloaded")
    return lines


# ── Step 4: Build flat rows ───────────────────────────────────

def build_rows(lines: list[dict]) -> list[dict]:
    """
    Bulk JSONL with edges/node structure:
      - Product lines   : no __parentId
      - Variant lines   : __parentId = product GID
      - Metafield lines : __parentId = product GID (namespace+key fields)
      - Variant metafield lines : __parentId = variant GID

    Output: 1 row per variant (Shopify standard format).
    Product-level fields are duplicated for each variant row.
    Products with no variants still produce 1 row with empty variant columns.
    """
    products: dict[str, dict]           = {}
    variants: dict[str, list[dict]]     = defaultdict(list)  # product_gid → [variant, ...]
    meta:     dict[str, dict]           = defaultdict(dict)  # product_gid → {ns.key: value}

    for obj in lines:
        gid    = obj.get("id", "")
        parent = obj.get("__parentId", "")

        if "/Product/" in gid and not parent:
            products[gid] = obj
        elif "/ProductVariant/" in gid and parent:
            variants[parent].append(obj)
        elif "namespace" in obj and "key" in obj and parent:
            # Metafield — keyed by its parent (product or variant GID)
            ns  = obj.get("namespace", "")
            key = obj.get("key", "")
            meta[parent][f"{ns}.{key}"] = obj.get("value", "")

    rows = []
    for pid, p in products.items():
        mf            = meta.get(pid, {})
        product_variants = variants.get(pid) or [{}]  # at least one empty row

        for v in product_variants:
            vid = v.get("id", "")
            inv = (v.get("inventoryItem") or {}).get("id", "")
            vmf = meta.get(vid, {})  # variant-level metafields (if any)

            row = {
                "Product GID":       pid,
                "Variant GID":       vid,
                "Inventory Item ID": inv,
                "Variant SKU":       v.get("sku", ""),
                "Handle":            p.get("handle", ""),
                "Title":             p.get("title", ""),
                "Body (HTML)":       p.get("descriptionHtml", ""),
                "Vendor":            p.get("vendor", ""),
                "Type":              p.get("productType", ""),
                "Tags":              ", ".join(p.get("tags") or []),
                "Status":            p.get("status", ""),
                "Published":         "TRUE" if p.get("publishedAt") else "FALSE",
                "Price":             v.get("price", ""),
                "Compare At Price":  v.get("compareAtPrice", "") or "",
                "Inventory":         v.get("inventoryQuantity", ""),
                "Image Src":         (p.get("featuredImage") or {}).get("url", ""),
                "SEO Title":         (p.get("seo") or {}).get("title", ""),
                "SEO Description":   (p.get("seo") or {}).get("description", ""),
                "Category":          (p.get("category") or {}).get("fullName", ""),
                "custom.good_id":    mf.get("custom.good_id", ""),
            }
            row.update(mf)   # product metafields
            row.update(vmf)  # variant metafields (overrides if same key)
            rows.append(row)

    print(f"  {len(rows)} variant rows parsed")
    return rows


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Export all Shopify products to Excel")
    parser.add_argument("--out", default=os.path.join(BASE_DIR, "output", "products_export.xlsx"),
                        help="Output Excel file path")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    print("Starting bulk product query...")
    op_id = start_bulk_query()
    if not op_id:
        sys.exit(1)

    print("Polling...")
    result_url = poll_status()
    if not result_url:
        sys.exit(1)

    lines = download_jsonl(result_url)
    rows  = build_rows(lines)

    if not rows:
        print("[INFO] No products found.")
        sys.exit(0)

    df = pd.DataFrame(rows)
    df.to_excel(args.out, index=False)
    print(f"\n✅ {len(rows)} products → {args.out}")


if __name__ == "__main__":
    main()
