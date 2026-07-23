"""
Bulk delete Shopify collections via Bulk Operation API.

Required CSV columns:
  - Collection GID   : Shopify collection GID (e.g. gid://shopify/Collection/123)

  ⚠️  WARNING: Deletion is permanent and cannot be undone.
      Script will ask for confirmation before proceeding.

Usage:
    py delete_collections.py --csv ../data/delete_list.xlsx
    py delete_collections.py --csv ../data/delete_list.xlsx --dry-run
    py delete_collections.py --csv ../data/delete_list.xlsx --yes   (skip confirmation)
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import time

import requests

from utils import make_headers, gql, read_csv_auto, API_URL, get_val

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

COL_GID    = "Collection GID"
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

BULK_MUTATION = (
    "mutation delCol($input: CollectionDeleteInput!) { "
    "collectionDelete(input: $input) { "
    "deletedCollectionId "
    "userErrors { field message } } }"
)


# ── Read CSV/Excel ────────────────────────────────────────────

def _read_df(path: str):
    import pandas as pd
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path, dtype=str).fillna("")
    return read_csv_auto(path)


# ── Step 1: Build JSONL ───────────────────────────────────────

def build_jsonl(df, out_path: str) -> int:
    if COL_GID not in df.columns:
        print(f"[ERR] Column '{COL_GID}' is required.")
        sys.exit(1)

    count = skipped = 0
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            gid = get_val(row, COL_GID)
            if not gid:
                skipped += 1
                continue
            f.write(json.dumps({"input": {"id": gid}}) + "\n")
            count += 1

    print(f"  {count} rows written → {out_path}  ({skipped} skipped)")
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
    outer = f"""
    mutation BulkDeleteCollections($stagedUploadPath: String!) {{
      bulkOperationRunMutation(
        mutation: "{BULK_MUTATION}",
        stagedUploadPath: $stagedUploadPath
      ) {{
        bulkOperation {{ id status }}
        userErrors {{ field message }}
      }}
    }}"""
    body = gql(API_URL, HEADERS, outer, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"[ERR] Bulk mutation: {op['userErrors']}")
        return None
    print(f"  Bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Step 4: Poll until COMPLETED ─────────────────────────────

def poll_status(interval: int = 10) -> str | None:
    query = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"
    while True:
        body = gql(API_URL, HEADERS, query)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
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
        description="Bulk delete Shopify collections via Bulk Operation API"
    )
    parser.add_argument(
        "--csv", required=True,
        help="CSV or Excel file with 'Collection GID' column",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Build JSONL only — do not upload or run mutation",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="Skip confirmation prompt (use with caution!)",
    )
    args = parser.parse_args()

    if os.path.exists(args.csv):
        csv_path = args.csv
    else:
        csv_path = os.path.join(os.path.dirname(BASE_DIR), args.csv)

    print(f"Reading : {csv_path}")
    df = _read_df(csv_path)
    print(f"Columns : {df.columns.tolist()}")
    print(f"Rows    : {len(df)}")

    out_jsonl = os.path.join(OUTPUT_DIR, "collections_delete.jsonl")
    count = build_jsonl(df, out_jsonl)

    if args.dry_run:
        print("[DRY RUN] JSONL built — no changes sent to Shopify.")
        return
    if count == 0:
        print("[INFO] Nothing to delete.")
        return

    # ── Safety confirmation ──
    if not args.yes:
        print(f"\n⚠️  About to PERMANENTLY DELETE {count} collections.")
        print("   This action cannot be undone!")
        confirm = input("   Type 'yes' to confirm: ").strip().lower()
        if confirm != "yes":
            print("   Aborted.")
            return

    print("\n── 1. Uploading JSONL ──")
    target = create_staged_upload("collections_delete.jsonl")
    if not target:
        sys.exit(1)
    res_url = upload_jsonl(target, out_jsonl)

    print("\n── 2. Running bulk mutation ──")
    op = run_bulk_mutation(res_url)
    if not op:
        sys.exit(1)

    print("\n── 3. Polling status ──")
    result_url = poll_status()
    print(f"\n✅ Done!  Result URL: {result_url}")


if __name__ == "__main__":
    main()
