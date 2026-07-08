"""
Export ALL Shopify product images to Excel via Bulk Operation API.

Uses 2 separate Bulk Operations (Shopify limitation: only 1 nested
connection per query):
  Query 1: products + variants  → SKU mapping
  Query 2: products + media     → image URLs

Then merges by Product GID.

Output columns (1 row per image):
  Variant SKU | Product GID | Product Title | Handle |
  Image Position | Image GID | Alt Text | Image URL | Width | Height

Usage:
    py export_images.py
    py export_images.py --out output/my_export.xlsx
    py export_images.py --no-empty    # skip products with no images
    py export_images.py --debug       # save JSONL sample to images/debug/
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

# ── Bulk queries ──────────────────────────────────────────────
# Shopify limitation: only ONE nested connection per bulk query.
# So we split into 2 queries and merge by Product GID.

QUERY_VARIANTS = """
{
  products {
    edges {
      node {
        id
        title
        handle
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
                alt
                image {
                  url
                  width
                  height
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
    """Start a bulk query, poll until done, return download URL."""
    print(f"\n[{label}] Starting bulk operation...")
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"query": inner_query})
    if not body:
        print(f"[{label}] ERROR: No response")
        return None

    op_data = body["data"]["bulkOperationRunQuery"]
    if op_data.get("userErrors"):
        print(f"[{label}] ERROR: {op_data['userErrors']}")
        return None

    print(f"[{label}] Started: {op_data['bulkOperation']['id']}")

    poll_q = "{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }"
    while True:
        res = gql(API_URL, HEADERS, poll_q)
        op  = (res or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print(f"[{label}] ERROR: No active bulk operation")
            return None
        print(f"  [{op['status']}] {op['objectCount']} objects")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[{label}] ERROR: {op['errorCode']}")
            return None
        time.sleep(10)


def download_jsonl(url: str, label: str, debug_dir: str | None = None) -> list[dict]:
    print(f"[{label}] Downloading...")
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"[{label}] {len(lines)} lines downloaded")

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        path = os.path.join(debug_dir, f"{label}_sample.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for obj in lines[:50]:
                f.write(json.dumps(obj) + "\n")
        print(f"[{label}] Sample saved → {path}")
    return lines


def parse_parent_children(lines: list[dict]) -> tuple[dict, dict]:
    """
    Split JSONL into:
      roots    : {gid → obj}          lines WITHOUT __parentId
      children : {parent_gid → [obj]} lines WITH __parentId
    """
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


# ── Build SKU map from Query 1 ────────────────────────────────

def build_sku_map(lines: list[dict]) -> dict[str, str]:
    """Returns {product_gid: first_variant_sku}"""
    roots, children = parse_parent_children(lines)
    sku_map: dict[str, str] = {}

    for gid, prod in roots.items():
        if "/Product/" not in gid:
            continue
        variants = [
            c for c in children.get(gid, [])
            if "/ProductVariant/" in c.get("id", "")
        ]
        if variants:
            variants.sort(key=lambda v: v.get("position", 9999))
            sku_map[gid] = variants[0].get("sku", "") or ""
        else:
            sku_map[gid] = ""

    have_sku = sum(1 for s in sku_map.values() if s)
    print(f"  SKU map: {len(sku_map)} products | {have_sku} have SKU")
    return sku_map


# ── Build image rows from Query 2 ─────────────────────────────

def build_image_rows(lines: list[dict], sku_map: dict[str, str]) -> list[dict]:
    """Returns 1 row per image; merges SKU from sku_map."""
    roots, children = parse_parent_children(lines)

    rows        = []
    img_total   = 0
    no_img      = 0

    for gid, prod in roots.items():
        if "/Product/" not in gid:
            continue

        sku   = sku_map.get(gid, "")
        media = [
            c for c in children.get(gid, [])
            if c.get("mediaContentType") or "/MediaImage/" in c.get("id", "")
        ]

        if not media:
            no_img += 1
            rows.append({
                "Variant SKU":    sku,
                "Product GID":    gid,
                "Product Title":  prod.get("title", ""),
                "Handle":         prod.get("handle", ""),
                "Image Position": "",
                "Image GID":      "",
                "Alt Text":       "",
                "Image URL":      "",
                "Width":          "",
                "Height":         "",
            })
            continue

        pos = 0
        for m in media:
            if m.get("mediaContentType", "IMAGE") != "IMAGE":
                continue
            pos += 1
            img = m.get("image") or {}
            rows.append({
                "Variant SKU":    sku,
                "Product GID":    gid,
                "Product Title":  prod.get("title", ""),
                "Handle":         prod.get("handle", ""),
                "Image Position": pos,
                "Image GID":      m.get("id", ""),
                "Alt Text":       m.get("alt", "") or "",
                "Image URL":      img.get("url", ""),
                "Width":          img.get("width", ""),
                "Height":         img.get("height", ""),
            })
            img_total += 1

    print(f"  {len(roots)} products | {img_total} images | {no_img} with no image")
    return rows


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Export all Shopify product images to Excel")
    parser.add_argument(
        "--out",
        default=os.path.join(BASE_DIR, "..", "products", "output", "images_export.xlsx"),
        help="Output Excel file path"
    )
    parser.add_argument("--no-empty", action="store_true",
                        help="Skip products with no images")
    parser.add_argument("--debug", action="store_true",
                        help="Save first 50 JSONL lines per query to images/debug/")
    args = parser.parse_args()

    out_path  = os.path.normpath(args.out)
    debug_dir = os.path.join(BASE_DIR, "debug") if args.debug else None
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # ── Query 1: variants → SKU map ──
    url1 = run_bulk_query(QUERY_VARIANTS, "Q1-variants")
    if not url1:
        sys.exit(1)
    lines1  = download_jsonl(url1, "Q1-variants", debug_dir)
    sku_map = build_sku_map(lines1)

    # ── Query 2: media → image rows ──
    url2 = run_bulk_query(QUERY_MEDIA, "Q2-media")
    if not url2:
        sys.exit(1)
    lines2 = download_jsonl(url2, "Q2-media", debug_dir)
    rows   = build_image_rows(lines2, sku_map)

    if not rows:
        print("[INFO] No products found.")
        sys.exit(0)

    # ── Filter --no-empty ──
    if args.no_empty:
        before = len(rows)
        rows   = [r for r in rows if r["Image URL"]]
        print(f"  Filtered: {before} → {len(rows)} rows")

    # ── Export to Excel ──
    COLS = [
        "Variant SKU", "Product GID", "Product Title", "Handle",
        "Image Position", "Image GID", "Alt Text",
        "Image URL", "Width", "Height",
    ]
    df = pd.DataFrame(rows, columns=COLS)

    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="All Images", index=False)

        summary = (
            df[df["Image URL"] != ""]
            .groupby(["Variant SKU", "Product GID", "Product Title", "Handle"])
            .agg(Image_Count=("Image URL", "count"))
            .reset_index()
            .rename(columns={"Image_Count": "Image Count"})
            .sort_values("Image Count", ascending=False)
        )
        summary.to_excel(writer, sheet_name="Summary", index=False)

    total_images   = df[df["Image URL"] != ""]["Image URL"].count()
    total_products = df["Product GID"].nunique()
    print(f"\n✅ {total_images} images from {total_products} products → {out_path}")
    print(f"   Sheets: 'All Images' + 'Summary'")


if __name__ == "__main__":
    main()
