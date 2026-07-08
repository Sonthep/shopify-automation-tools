"""
Export Shopify products to Excel — custom column set.

Columns exported:
  custom.good_id, Variant SKU, Handle,
  Title, Title TH,
  Body (HTML), Body (HTML) TH,
  Vendor, Type, Tags, Status,
  Price, Compare At Price, Inventory, Image Src,
  custom.part_type, custom.power_type, custom.link_pdf

Thai translations are fetched via batched translatableResource queries
after the bulk export completes.

Usage:
    py get_product_custom.py
    py get_product_custom.py --out output/custom_export.xlsx
    py get_product_custom.py --no-thai
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

LOCALE = "th"

# ── Bulk query ────────────────────────────────────────────────

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
        featuredImage { url }
        variants {
          edges {
            node {
              sku
              price
              compareAtPrice
              inventoryQuantity
            }
          }
        }
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

# ── Step 1: Start bulk query ──────────────────────────────────

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

def poll_status(interval: int = 10) -> str | None:
    query = "{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }"
    while True:
        body = gql(API_URL, HEADERS, query)
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
    print("Downloading result...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} lines downloaded")
    return lines


# ── Step 4: Build flat rows ───────────────────────────────────

def _to_int(value):
    try:
        return int(float(str(value).strip()))
    except (ValueError, TypeError):
        return ""


def build_rows(lines: list[dict]) -> tuple[list[dict], list[str]]:
    """Parse JSONL into flat rows. Returns (rows, list_of_product_gids)."""
    products: dict[str, dict]       = {}
    variants: dict[str, list[dict]] = defaultdict(list)
    meta:     dict[str, dict]       = defaultdict(dict)

    for obj in lines:
        gid    = obj.get("id", "")
        parent = obj.get("__parentId", "")

        if "/Product/" in gid and not parent:
            products[gid] = obj
        elif "/ProductVariant/" in gid and parent:
            variants[parent].append(obj)
        elif "namespace" in obj and "key" in obj and parent:
            ns  = obj.get("namespace", "")
            key = obj.get("key", "")
            meta[parent][f"{ns}.{key}"] = obj.get("value", "")

    rows = []
    product_gids = []

    for pid, p in products.items():
        mf               = meta.get(pid, {})
        product_variants = variants.get(pid) or [{}]
        product_gids.append(pid)

        for v in product_variants:
            row = {
                "custom.good_id":    _to_int(mf.get("custom.good_id", "")),
                "Variant SKU":       v.get("sku", ""),
                "Product GID":       pid,
                "Handle":            p.get("handle", ""),
                "Title":             p.get("title", ""),
                "Title TH":          "",  # filled later
                "Body (HTML)":       p.get("descriptionHtml", ""),
                "Body (HTML) TH":    "",  # filled later
                "Vendor":            p.get("vendor", ""),
                "Type":              p.get("productType", ""),
                "Tags":              ", ".join(p.get("tags") or []),
                "Status":            p.get("status", ""),
                "Price":             v.get("price", ""),
                "Compare At Price":  v.get("compareAtPrice", "") or "",
                "Inventory":         v.get("inventoryQuantity", ""),
                "Image Src":         (p.get("featuredImage") or {}).get("url", ""),
                "custom.part_type":  mf.get("custom.part_type", ""),
                "custom.power_type": mf.get("custom.power_type", ""),
                "custom.link_pdf":   mf.get("custom.link_pdf", ""),
            }
            rows.append(row)

    print(f"  {len(rows)} variant rows parsed  ({len(products)} products)")
    return rows, product_gids


# ── Step 5: Fetch Thai translations ──────────────────────────

THAI_FIELDS = {"title": "Title TH", "body_html": "Body (HTML) TH"}


def fetch_thai_translations(product_gids: list[str], batch_size: int = 50) -> dict[str, dict]:
    """
    Returns {product_gid: {"Title TH": "...", "Body (HTML) TH": "..."}}
    Uses batched alias queries against translatableResource.
    """
    result: dict[str, dict] = {}
    total = len(product_gids)

    for i in range(0, total, batch_size):
        batch = product_gids[i:i + batch_size]
        aliases = "\n".join([
            f'r{j}: translatableResource(resourceId: "{gid}") '
            f'{{ translations(locale: "{LOCALE}") {{ key value }} }}'
            for j, gid in enumerate(batch)
        ])
        body = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        if body is None or body.get("errors"):
            print(f"  [WARN] Thai batch {i//batch_size + 1} error: {(body or {}).get('errors')}")
            for gid in batch:
                result[gid] = {}
            continue

        data = body.get("data", {})
        for j, gid in enumerate(batch):
            resource = data.get(f"r{j}")
            translations = {}
            if resource:
                for t in resource.get("translations", []):
                    col = THAI_FIELDS.get(t["key"])
                    if col:
                        translations[col] = t.get("value", "")
            result[gid] = translations

        print(f"  Thai translations fetched {min(i + batch_size, total)}/{total}")
        time.sleep(0.3)

    return result


# ── Step 6: Merge Thai into rows ──────────────────────────────

def merge_thai(rows: list[dict], thai_map: dict[str, dict]) -> list[dict]:
    for row in rows:
        pid  = row.get("Product GID", "")
        thai = thai_map.get(pid, {})
        row["Title TH"]       = thai.get("Title TH", "")
        row["Body (HTML) TH"] = thai.get("Body (HTML) TH", "")
    return rows


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Custom Shopify product export with Thai translations")
    parser.add_argument(
        "--out", default=os.path.join(BASE_DIR, "output", "products_custom.xlsx"),
        help="Output Excel file path"
    )
    parser.add_argument(
        "--no-thai", action="store_true",
        help="Skip Thai translation fetch"
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    # ── 1. Bulk export ──
    print("Starting bulk product query...")
    op_id = start_bulk_query()
    if not op_id:
        sys.exit(1)

    print("Polling...")
    result_url = poll_status()
    if not result_url:
        sys.exit(1)

    lines = download_jsonl(result_url)
    rows, product_gids = build_rows(lines)

    if not rows:
        print("[INFO] No products found.")
        sys.exit(0)

    # ── 2. Thai translations ──
    if not args.no_thai:
        print(f"\nFetching Thai translations for {len(product_gids)} products...")
        thai_map = fetch_thai_translations(product_gids)
        rows = merge_thai(rows, thai_map)
    else:
        print("Skipping Thai translations (--no-thai)")

    # ── 3. Export ──
    EXPORT_COLS = [
        "custom.good_id",
        "Variant SKU",
        "Handle",
        "Title",
        "Title TH",
        "Body (HTML)",
        "Body (HTML) TH",
        "Vendor",
        "Type",
        "Tags",
        "Status",
        "Price",
        "Compare At Price",
        "Inventory",
        "Image Src",
        "custom.part_type",
        "custom.power_type",
        "custom.link_pdf",
    ]

    df = pd.DataFrame(rows)
    # Keep only desired columns (in order), add any missing as empty
    for col in EXPORT_COLS:
        if col not in df.columns:
            df[col] = ""
    df = df[EXPORT_COLS]

    df.to_excel(args.out, index=False)
    print(f"\n✅ {len(rows)} rows exported → {args.out}")


if __name__ == "__main__":
    main()
