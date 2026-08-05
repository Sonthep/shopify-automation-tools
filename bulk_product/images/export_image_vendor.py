"""
Export Shopify Vendor Collection Images (Logos/Header Images) to Excel/CSV.

Fetches per Vendor Collection:
  - Vendor Name         (from rule condition 'column == VENDOR' or Title)
  - Collection Title    (e.g., PRIMO, Sirman, Pujadas)
  - Collection Handle   (URL handle)
  - Collection GID      (for API updates)
  - Image URL           (Collection header/logo image URL)
  - Image Alt Text      (Image alt text)
  - Image Width & Height
  - Description         (Collection description)
  - Vendor Rule Condition
  - Updated At timestamp

Features:
  - Filter by specific Vendor (`--vendor "PRIMO"`)
  - Export all collections or only VENDOR rule collections (default: VENDOR collections only)
  - Filter out collections without images (`--no-empty`)
  - Automatically download collection image files to local folder (`--download`)

Usage:
    py export_image_vendor.py
    py export_image_vendor.py --vendor "PRIMO"
    py export_image_vendor.py --download
    py export_image_vendor.py --out output/vendor_collection_images.xlsx
    py export_image_vendor.py --all-collections
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import sys
import time
import requests
import pandas as pd

from utils import make_headers, gql, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

# ── Bulk GraphQL Query ──────────────────────────────────────────

QUERY_COLLECTIONS = """
{
  collections {
    edges {
      node {
        id
        title
        handle
        description
        descriptionHtml
        updatedAt
        image {
          id
          url
          altText
          width
          height
        }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
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

POLL_QUERY = "{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }"


# ── Bulk Operation Helpers ─────────────────────────────────────

def run_bulk_query(query_str: str, label: str) -> str | None:
    """Start bulk query, poll until COMPLETED, return result download URL."""
    print(f"[{label}] Starting bulk operation...")
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"query": query_str})
    if not body:
        print(f"[{label}] ERROR: No response")
        return None

    op_data = body["data"]["bulkOperationRunQuery"]
    if op_data.get("userErrors"):
        print(f"[{label}] ERROR: {op_data['userErrors']}")
        return None

    op_id = op_data['bulkOperation']['id']
    print(f"[{label}] Bulk operation started: {op_id}")

    while True:
        res = gql(API_URL, HEADERS, POLL_QUERY)
        op  = (res or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print(f"[{label}] ERROR: No active bulk operation")
            return None
        print(f"  [{op['status']}] {op['objectCount']} objects processed")
        if op["status"] == "COMPLETED":
            return op.get("url")
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[{label}] ERROR: {op.get('errorCode')}")
            return None
        time.sleep(5)


def download_jsonl(url: str, label: str, debug_dir: str | None = None) -> list[dict]:
    """Download JSONL results from bulk operation URL."""
    print(f"[{label}] Downloading results...")
    resp = requests.get(url, timeout=180)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"[{label}] {len(lines)} lines downloaded")

    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        sample_path = os.path.join(debug_dir, f"{label}_sample.jsonl")
        with open(sample_path, "w", encoding="utf-8") as f:
            for obj in lines[:50]:
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        print(f"[{label}] Sample saved → {sample_path}")

    return lines


# ── Parsing Collections & Rules ────────────────────────────────

def parse_collection_rows(lines: list[dict], only_vendor: bool = True, vendor_filter: str | None = None) -> list[dict]:
    """
    Parses JSONL bulk operation lines into flat collection dictionaries.
    Handles both inline ruleSet and child CollectionRule JSON lines.
    """
    collections: dict[str, dict]       = {}
    child_rules: dict[str, list[dict]] = {}

    for obj in lines:
        gid    = obj.get("id", "")
        parent = obj.get("__parentId", "")

        if parent:
            # Child object (e.g., CollectionRule)
            if parent not in child_rules:
                child_rules[parent] = []
            child_rules[parent].append(obj)
        elif "/Collection/" in gid:
            collections[gid] = obj

    rows = []
    for cid, c in collections.items():
        # Combine rules from inline ruleSet and child lines
        rules = []

        # 1. Inline ruleSet rules
        rule_set = c.get("ruleSet")
        if isinstance(rule_set, dict):
            inline_rules = rule_set.get("rules") or []
            if isinstance(inline_rules, list):
                rules.extend(inline_rules)

        # 2. Child rule lines
        if cid in child_rules:
            for r_obj in child_rules[cid]:
                if "column" in r_obj:
                    rules.append(r_obj)

        # Extract Vendor conditions from rules
        vendor_conditions = []
        for r in rules:
            col = str(r.get("column", "")).upper()
            if col == "VENDOR":
                cond = r.get("condition")
                if cond:
                    vendor_conditions.append(str(cond))

        is_vendor_col = len(vendor_conditions) > 0
        vendor_name   = ", ".join(vendor_conditions) if is_vendor_col else c.get("title", "")

        # Filter: Vendor collections only
        if only_vendor and not is_vendor_col:
            continue

        # Filter: Specific vendor name
        if vendor_filter:
            vf = vendor_filter.lower()
            if vf not in vendor_name.lower() and vf not in c.get("title", "").lower():
                continue

        # Image metadata
        img_obj = c.get("image") or {}
        img_url = img_obj.get("url", "") or ""

        rows.append({
            "Vendor Name":        vendor_name,
            "Collection Title":   c.get("title", ""),
            "Handle":             c.get("handle", ""),
            "Collection GID":     cid,
            "Image URL":          img_url,
            "Image Alt Text":     img_obj.get("altText", "") or "",
            "Image Width":        img_obj.get("width", "") or "",
            "Image Height":       img_obj.get("height", "") or "",
            "Description":        c.get("description", "") or "",
            "Vendor Conditions":  ", ".join(vendor_conditions),
            "Updated At":         c.get("updatedAt", "") or "",
        })

    print(f"  Parsed {len(rows)} matching collection(s)")
    return rows


# ── Downloading Images ─────────────────────────────────────────

def download_collection_images(rows: list[dict], output_dir: str):
    """Download collection header/logo image files into a local folder."""
    os.makedirs(output_dir, exist_ok=True)
    print(f"\n[DOWNLOAD] Downloading collection images to: {output_dir}")

    downloaded = 0
    skipped    = 0
    failed     = 0

    for r in rows:
        url = r.get("Image URL")
        if not url:
            skipped += 1
            continue

        # Determine file extension from URL or fallback to jpg
        ext = ".jpg"
        clean_url = url.split("?")[0]
        if "." in clean_url:
            potential_ext = os.path.splitext(clean_url)[1].lower()
            if potential_ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"):
                ext = potential_ext

        filename = f"{r['Handle']}{ext}"
        filepath = os.path.join(output_dir, filename)

        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            with open(filepath, "wb") as f:
                f.write(resp.content)
            downloaded += 1
            print(f"  ✅ Saved: {filename} ({r['Vendor Name']})")
        except Exception as e:
            failed += 1
            print(f"  ❌ Failed: {filename} ({e})")

    print(f"[DOWNLOAD COMPLETE] Downloaded: {downloaded} | Skipped (no URL): {skipped} | Failed: {failed}")


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Export Shopify Vendor Collection Images to Excel/CSV")
    parser.add_argument(
        "--out", "-o",
        default=os.path.join(BASE_DIR, "..", "products", "output", "vendor_collection_images.xlsx"),
        help="Output Excel/CSV file path"
    )
    parser.add_argument(
        "--vendor", "-v",
        default=None,
        help="Filter collections by Vendor name (e.g. --vendor PRIMO or --vendor Sirman)"
    )
    parser.add_argument(
        "--all-collections", action="store_true",
        help="Export all collections, not just collections with VENDOR rule"
    )
    parser.add_argument(
        "--no-empty", action="store_true",
        help="Skip collections that do not have a collection image"
    )
    parser.add_argument(
        "--download", "-d", action="store_true",
        help="Download collection images to a local folder"
    )
    parser.add_argument(
        "--download-dir",
        default=os.path.join(BASE_DIR, "..", "products", "output", "vendor_images"),
        help="Folder path for downloaded collection images"
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="Save raw JSONL sample to images/debug/"
    )
    args = parser.parse_args()

    out_path  = os.path.normpath(args.out)
    debug_dir = os.path.join(BASE_DIR, "debug") if args.debug else None
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # 1. Run Bulk Query
    url = run_bulk_query(QUERY_COLLECTIONS, "VendorCollections")
    if not url:
        sys.exit(1)

    # 2. Download JSONL & Parse
    lines = download_jsonl(url, "VendorCollections", debug_dir)
    rows  = parse_collection_rows(
        lines,
        only_vendor=not args.all_collections,
        vendor_filter=args.vendor
    )

    if not rows:
        print("[INFO] No collections found matching criteria.")
        sys.exit(0)

    # 3. Filter --no-empty
    if args.no_empty:
        before = len(rows)
        rows   = [r for r in rows if r["Image URL"]]
        print(f"  Filtered empty images: {before} → {len(rows)} collections")

    # 4. Save to Excel / CSV
    df = pd.DataFrame(rows)

    if out_path.endswith(".csv"):
        df.to_csv(out_path, index=False, encoding="utf-8-sig")
        print(f"\n✅ Saved {len(df)} collection rows → {out_path}")
    else:
        with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
            df.to_excel(writer, sheet_name="Vendor Collections", index=False)

            # Summary Sheet
            with_img_count = (df["Image URL"] != "").sum()
            summary_data = [
                {"Metric": "Total Vendor Collections", "Value": len(df)},
                {"Metric": "Collections With Images", "Value": with_img_count},
                {"Metric": "Collections Without Images", "Value": len(df) - with_img_count},
            ]
            pd.DataFrame(summary_data).to_excel(writer, sheet_name="Summary", index=False)

        print(f"\n✅ Saved {len(df)} collection rows → {out_path}")
        print(f"   Sheets: 'Vendor Collections', 'Summary'")

    # 5. Download images if requested
    if args.download:
        download_collection_images(rows, args.download_dir)


if __name__ == "__main__":
    main()
