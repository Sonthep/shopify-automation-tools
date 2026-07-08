"""
Export Shopify product images in WIDE format:
  1 row per SKU, each image in its own column.

Output:
  custom.good_id | Variant SKU | Image URL 1 | Image URL 2 | Image URL 3 | ...

The number of columns matches the product with the most images.
Products with fewer images leave the extra columns blank.

Usage:
    py export_images_wide.py
    py export_images_wide.py --out output/images_wide.xlsx
    py export_images_wide.py --no-empty   # skip SKUs with no images
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

# ── Bulk queries (1 nested connection each) ───────────────────

QUERY_VARIANTS = """
{
  products {
    edges {
      node {
        id
        metafield(namespace: "custom", key: "good_id") {
          value
        }
        variants {
          edges {
            node {
              id
              sku
              position
            }
          }
        }
      }
    }
  }
}
"""

QUERY_MEDIA = """
{
  products {
    edges {
      node {
        id
        media {
          edges {
            node {
              id
              mediaContentType
              ... on MediaImage {
                id
                image {
                  url
                }
              }
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


# ── Helpers ───────────────────────────────────────────────────

def run_bulk_query(inner_query: str, label: str) -> str | None:
    print(f"\n[{label}] Starting...")
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"query": inner_query})
    if not body:
        return None
    op_data = body["data"]["bulkOperationRunQuery"]
    if op_data.get("userErrors"):
        print(f"  ERROR: {op_data['userErrors']}")
        return None
    print(f"  ID: {op_data['bulkOperation']['id']}")

    poll_q = "{ currentBulkOperation(type: QUERY) { status errorCode objectCount url } }"
    while True:
        res = gql(API_URL, HEADERS, poll_q)
        op  = (res or {}).get("data", {}).get("currentBulkOperation")
        if not op:
            return None
        print(f"  [{op['status']}] {op['objectCount']} objects")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"  ERROR: {op['errorCode']}")
            return None
        time.sleep(10)


def download_jsonl(url: str, label: str) -> list[dict]:
    print(f"[{label}] Downloading...")
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} lines")
    return lines


def parse_parent_children(lines: list[dict]) -> tuple[dict, dict]:
    roots:    dict[str, dict]       = {}
    children: dict[str, list[dict]] = defaultdict(list)
    for obj in lines:
        parent = obj.get("__parentId", "")
        gid    = obj.get("id", "")
        if parent:
            children[parent].append(obj)
        elif gid:
            roots[gid] = obj
    return roots, children


# ── Build data ────────────────────────────────────────────────

def build_meta_map(lines: list[dict]) -> dict[str, dict]:
    """Returns {product_gid: {"sku": "...", "good_id": "..."}}"""
    roots, children = parse_parent_children(lines)
    meta_map = {}
    for gid, prod in roots.items():
        if "/Product/" not in gid:
            continue
        variants = sorted(
            [c for c in children.get(gid, []) if "/ProductVariant/" in c.get("id", "")],
            key=lambda v: v.get("position", 9999)
        )
        sku = variants[0].get("sku", "") if variants else ""
        
        # Metafield comes as an inline object for single-object queries
        meta = prod.get("metafield") or {}
        good_id = meta.get("value", "")
        
        meta_map[gid] = {"sku": sku, "good_id": good_id}
        
    have_sku = sum(1 for m in meta_map.values() if m["sku"])
    have_good_id = sum(1 for m in meta_map.values() if m["good_id"])
    print(f"  {len(meta_map)} products | {have_sku} have SKU | {have_good_id} have good_id")
    return meta_map


def build_wide_rows(
    media_lines: list[dict],
    meta_map: dict[str, dict],
    no_empty: bool = False,
) -> tuple[list[dict], int]:
    """
    Returns:
      rows        : list of {Variant SKU, Image URL 1, Image URL 2, ...}
      max_images  : maximum number of images for any single SKU
    """
    roots, children = parse_parent_children(media_lines)

    rows       = []
    max_images = 0

    for gid, prod in roots.items():
        if "/Product/" not in gid:
            continue

        meta = meta_map.get(gid, {})
        sku = meta.get("sku", "")
        good_id = meta.get("good_id", "")

        # Collect image URLs (IMAGE type only), ordered by position
        urls = []
        for m in children.get(gid, []):
            if m.get("mediaContentType", "IMAGE") != "IMAGE":
                continue
            img_url = (m.get("image") or {}).get("url", "")
            if img_url:
                urls.append(img_url)

        if no_empty and not urls:
            continue

        max_images = max(max_images, len(urls))

        row = {
            "custom.good_id": good_id,
            "Variant SKU": sku
        }
        for i, url in enumerate(urls, start=1):
            row[f"Image URL {i}"] = url

        rows.append(row)

    print(f"  {len(rows)} rows | max {max_images} images per SKU")
    return rows, max_images


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Export Shopify images — wide format (1 row per SKU)"
    )
    parser.add_argument(
        "--out",
        default=os.path.join(BASE_DIR, "..", "products", "output", "images_wide.xlsx"),
        help="Output Excel file path"
    )
    parser.add_argument("--no-empty", action="store_true",
                        help="Skip SKUs with no images")
    args = parser.parse_args()

    out_path = os.path.normpath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # ── Q1: Variants + Metafields → meta map ──
    url1 = run_bulk_query(QUERY_VARIANTS, "Q1-variants")
    if not url1:
        sys.exit(1)
    lines1  = download_jsonl(url1, "Q1-variants")
    meta_map = build_meta_map(lines1)

    # ── Q2: Media → image rows ──
    url2 = run_bulk_query(QUERY_MEDIA, "Q2-media")
    if not url2:
        sys.exit(1)
    lines2 = download_jsonl(url2, "Q2-media")
    rows, max_images = build_wide_rows(lines2, meta_map, no_empty=args.no_empty)

    if not rows:
        print("[INFO] No rows to export.")
        sys.exit(0)

    # ── Build full column list ──
    img_cols = [f"Image URL {i}" for i in range(1, max_images + 1)]
    all_cols = ["custom.good_id", "Variant SKU"] + img_cols

    # Fill missing image columns with empty string
    for row in rows:
        for col in img_cols:
            row.setdefault(col, "")

    df = pd.DataFrame(rows, columns=all_cols)
    df = df.sort_values(["custom.good_id", "Variant SKU"]).reset_index(drop=True)

    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Images Wide", index=False)

    total_skus   = len(df)
    total_images = df[img_cols].apply(lambda c: c.str.strip().astype(bool)).sum().sum()
    print(f"\n✅ {total_skus} SKUs | {total_images} images | max {max_images} per SKU")
    print(f"   Columns: custom.good_id + Variant SKU + {max_images} Image URL columns")
    print(f"   → {out_path}")


if __name__ == "__main__":
    main()
