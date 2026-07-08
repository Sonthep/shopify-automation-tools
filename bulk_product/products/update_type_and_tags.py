"""
Bulk update productType and tags for Shopify products via Bulk Mutation API.

Required CSV columns:
  - Product GID  : Shopify product GID (e.g. gid://shopify/Product/12345)
  - Type         : New product type (leave blank to skip updating Type)
  - Tags         : Comma-separated tags (leave blank to skip updating Tags)

Usage:
    py update_type_and_tags.py --csv output/products_export.xlsx
    py update_type_and_tags.py --csv data/type_tags.csv --dry-run
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import time

import requests
import pandas as pd

from utils import make_headers, gql, read_csv_auto, API_URL, get_val

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

GID_COLUMN  = "Product GID"
TYPE_COLUMN = "Type"
TAGS_COLUMN = "Tags"


# ── Step 1: Build JSONL ───────────────────────────────────────

def build_jsonl(df: pd.DataFrame, out_jsonl: str) -> int:
    """Build JSONL file for updating productType and tags from CSV.

    Rules:
      - Type column present & not blank  → set productType to that value
      - Type column present & blank      → clear productType (set to "")
      - Type column missing              → skip productType field
      - Tags column present & not blank  → set tags to split list
      - Tags column present & blank      → clear all tags (set to [])
      - Tags column missing              → skip tags field
    """
    if GID_COLUMN not in df.columns:
        print(f"[ERR] Need '{GID_COLUMN}' column in CSV.")
        sys.exit(1)

    count = 0
    skipped = 0
    has_type = TYPE_COLUMN in df.columns
    has_tags = TAGS_COLUMN in df.columns

    if not has_type and not has_tags:
        print(f"[ERR] CSV must have at least one of '{TYPE_COLUMN}' or '{TAGS_COLUMN}' columns.")
        sys.exit(1)

    os.makedirs(os.path.dirname(out_jsonl), exist_ok=True)

    with open(out_jsonl, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            gid = get_val(row, GID_COLUMN)
            if not gid:
                skipped += 1
                continue

            input_data: dict = {"id": gid}

            # ── Type ──
            if has_type:
                raw_type = row.get(TYPE_COLUMN)
                if pd.notna(raw_type):
                    input_data["productType"] = str(raw_type).strip()

            # ── Tags ──
            if has_tags:
                raw_tags = row.get(TAGS_COLUMN)
                if pd.notna(raw_tags):
                    tags_str = str(raw_tags).strip()
                    if tags_str:
                        input_data["tags"] = [t.strip() for t in tags_str.split(",") if t.strip()]
                    else:
                        input_data["tags"] = []  # clear all tags

            # Must have at least one field besides "id"
            if len(input_data) <= 1:
                skipped += 1
                continue

            f.write(json.dumps({"input": input_data}) + "\n")
            count += 1

    print(f"  {count} rows written → {out_jsonl}  ({skipped} skipped)")
    return count


# ── Step 2: Staged upload ─────────────────────────────────────

def create_staged_upload(filename: str) -> dict | None:
    query = f"""
    mutation {{
      stagedUploadsCreate(input: {{
        resource: BULK_MUTATION_VARIABLES,
        filename: "{filename}",
        mimeType: "text/jsonl",
        httpMethod: PUT
      }}) {{
        stagedTargets {{ url resourceUrl parameters {{ name value }} }}
        userErrors {{ field message }}
      }}
    }}"""
    body = gql(API_URL, HEADERS, query)
    if not body:
        return None
    data = body["data"]["stagedUploadsCreate"]
    if data.get("userErrors"):
        print(f"[ERR] stagedUploadsCreate: {data['userErrors']}")
        return None
    return data["stagedTargets"][0]


def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"  Uploaded {filepath}  (HTTP {res.status_code})")
    return target["resourceUrl"]


# ── Step 3: Run bulk mutation ─────────────────────────────────

def run_bulk_mutation(resource_url: str) -> dict | None:
    mutation = """
    mutation BulkUpdateTypeAndTags($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation updateTypeAndTags($input: ProductInput!) { productUpdate(input: $input) { product { id productType tags } userErrors { field message } } }",
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }"""
    body = gql(API_URL, HEADERS, mutation, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"[ERR] Bulk mutation: {op['userErrors']}")
        return None
    print(f"  Bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Step 4: Poll until COMPLETED ─────────────────────────────

def poll_status(interval: int = 15) -> str | None:
    query = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"
    while True:
        body = gql(API_URL, HEADERS, query)
        op = (body or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print("[ERR] No active bulk operation found.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows processed")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[ERR] Bulk operation failed: {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Bulk update Product Type and Tags in Shopify from CSV/Excel"
    )
    parser.add_argument(
        "--csv", required=True,
        help="CSV or Excel file with columns: 'Product GID', 'Type', 'Tags'"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Build JSONL only — do not upload or run mutation"
    )
    args = parser.parse_args()

    # Resolve CSV path
    if os.path.exists(args.csv):
        csv_path = args.csv
    else:
        csv_path = os.path.join(os.path.dirname(BASE_DIR), args.csv)

    print(f"Reading : {csv_path}")
    df = read_csv_auto(csv_path)
    print(f"Columns : {df.columns.tolist()}")
    print(f"Rows    : {len(df)}")

    out_jsonl = os.path.join(BASE_DIR, "output", "update_type_tags.jsonl")
    count = build_jsonl(df, out_jsonl)

    if args.dry_run:
        print("[DRY RUN] JSONL built — no changes sent to Shopify.")
        return

    if count == 0:
        print("[INFO] Nothing to update.")
        return

    print("\n── 1. Uploading JSONL ──")
    target = create_staged_upload("update_type_tags.jsonl")
    if not target:
        sys.exit(1)

    res_url = upload_jsonl(target, out_jsonl)

    print("\n── 2. Running bulk mutation ──")
    op = run_bulk_mutation(res_url)
    if not op:
        sys.exit(1)

    print("\n── 3. Polling status ──")
    result_url = poll_status()
    print(f"\n✅ Done! Result URL: {result_url}")


if __name__ == "__main__":
    main()
