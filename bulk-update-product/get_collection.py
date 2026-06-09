"""
Export ALL Shopify collections to Excel via Bulk Operation API.

Usage:
    py get_collection.py
    py get_collection.py --out output/collections_export.xlsx
"""

import argparse
import json
import os
import sys
import time

import pandas as pd
import requests

from utils import make_headers, gql, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

# ── Step 1: Start bulk query ──────────────────────────────────

INNER_QUERY = """
{
  collections {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        updatedAt
        image { url }
        ruleSet {
          rules {
            column
            condition
            relation
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
            return op.get("url")
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[ERROR] {op.get('errorCode')}")
            return None
        time.sleep(interval)


# ── Step 3: Download & parse JSONL ───────────────────────────

def download_jsonl(url: str) -> list[dict]:
    if not url:
        return []
    print(f"Downloading result...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} lines downloaded")
    return lines


# ── Step 4: Build flat rows ───────────────────────────────────

def build_rows(lines: list[dict], only_vendor: bool = False) -> list[dict]:
    collections = {}

    for obj in lines:
        gid    = obj.get("id", "")
        parent = obj.get("__parentId", "")

        if "/Collection/" in gid and not parent:
            collections[gid] = obj

    rows = []
    for cid, c in collections.items():
        if only_vendor:
            is_vendor = False
            rule_set = c.get("ruleSet")
            if rule_set:
                rules = rule_set.get("rules") or []
                if any(r.get("column") == "VENDOR" for r in rules):
                    is_vendor = True
            if not is_vendor:
                continue

        row = {
            "Collection GID":    cid,
            "Handle":            c.get("handle", ""),
            "Title":             c.get("title", ""),
            "Description HTML":  c.get("descriptionHtml", ""),
            "Updated At":        c.get("updatedAt", ""),
            "Image URL":         (c.get("image") or {}).get("url", ""),
        }
        
        if only_vendor:
            vendor_names = []
            rule_set = c.get("ruleSet") or {}
            for r in (rule_set.get("rules") or []):
                if r.get("column") == "VENDOR":
                    vendor_names.append(str(r.get("condition")))
            row["Vendor Condition"] = ", ".join(vendor_names)

        rows.append(row)

    print(f"  {len(rows)} collections parsed")
    return rows


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Export all Shopify collections to Excel")
    parser.add_argument("--out", default=os.path.join(BASE_DIR, "output", "collections_export.xlsx"),
                        help="Output Excel file path")
    parser.add_argument("--only-vendor", action="store_true",
                        help="Filter only collections that have a VENDOR rule")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    print("Starting bulk collection query...")
    op_id = start_bulk_query()
    if not op_id:
        sys.exit(1)

    print("Polling...")
    result_url = poll_status()
    if not result_url:
        print("[INFO] No data returned (URL is null). Probably 0 collections.")
        sys.exit(0)

    lines = download_jsonl(result_url)
    rows  = build_rows(lines, only_vendor=args.only_vendor)

    if not rows:
        print("[INFO] No collections found.")
        sys.exit(0)

    df = pd.DataFrame(rows)
    df.to_excel(args.out, index=False)
    print(f"\n✅ {len(rows)} collections → {args.out}")


if __name__ == "__main__":
    main()
