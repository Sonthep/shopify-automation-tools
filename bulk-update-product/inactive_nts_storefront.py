"""
Bulk-unpublish Shopify products from the 'NTS Storefront' sales channel via Bulk Operation API.

Reads a list of Product GIDs from a CSV or TXT file and unpublishes them from
NTS Storefront (Publication ID: gid://shopify/Publication/190473797831)
using bulkOperationRunMutation → publishableUnpublish.

Usage
-----
    # From CSV (must have "Product GID" column)
    py inactive_nts_storefront.py --csv data/products.csv

    # From plain-text GID list
    # From plain-text GID list
    py inactive_nts_storefront.py --gids data/gids.txt
"""

import argparse
import json
import os
import sys
import time

import requests

from utils import make_headers, gql, read_csv_auto, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

NTS_STOREFRONT_PUB_ID = "gid://shopify/Publication/190473797831"

# ── Step 1: Collect GIDs ──────────────────────────────────────

def load_gids_from_csv(csv_file: str) -> list[str]:
    df = read_csv_auto(csv_file)
    print(f"  Columns found: {df.columns.tolist()}")
    
    # Try common GID columns
    gid_col = None
    for col in ["Collection GID", "Product GID", "GID"]:
        if col in df.columns:
            gid_col = col
            break
            
    if not gid_col:
        print(f"[ERR] No valid GID column ('Collection GID', 'Product GID', or 'GID') found in {csv_file}")
        sys.exit(1)
        
    gids = df[gid_col].dropna().astype(str).str.strip().tolist()
    gids = [g for g in gids if g.startswith("gid://shopify/Product/") or g.startswith("gid://shopify/Collection/")]
    print(f"  {len(gids)} valid GIDs loaded from {csv_file} (using column '{gid_col}')")
    return gids


def load_gids_from_txt(txt_file: str) -> list[str]:
    gids: list[str] = []
    with open(txt_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("gid://shopify/Product/") or line.startswith("gid://shopify/Collection/"):
                gids.append(line)
    print(f"  {len(gids)} valid GIDs loaded from {txt_file}")
    return gids


# ── Step 2: Build JSONL ───────────────────────────────────────

def build_unpublish_jsonl(gids: list[str], jsonl_file: str) -> int:
    os.makedirs(os.path.dirname(jsonl_file), exist_ok=True)
    count = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for gid in gids:
            # We supply id and input to match the mutation variables
            payload = {
                "id": gid,
                "input": [{"publicationId": NTS_STOREFRONT_PUB_ID}]
            }
            f.write(json.dumps(payload) + "\n")
            count += 1
    print(f"  {count} rows written → {jsonl_file}")
    return count


# ── Step 3: Staged upload ─────────────────────────────────────

def create_staged_upload(filename: str = "unpublish_nts_bulk.jsonl") -> dict | None:
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
    target = data["stagedTargets"][0]
    return target


def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"  Uploaded {filepath}  (HTTP {res.status_code})")
    return target["resourceUrl"]


# ── Step 4: Run bulk mutation ─────────────────────────────────

BULK_MUTATION = """
mutation BulkUnpublish($stagedUploadPath: String!) {
  bulkOperationRunMutation(
    mutation: "mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
      publishableUnpublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }",
    stagedUploadPath: $stagedUploadPath
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}"""


def run_bulk_mutation(resource_url: str) -> dict | None:
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"[ERR] Bulk mutation: {op['userErrors']}")
        return None
    print(f"  Bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Step 5: Poll until done ───────────────────────────────────

POLL_QUERY = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"

def poll_status(interval: int = 15) -> str | None:
    while True:
        body = gql(API_URL, HEADERS, POLL_QUERY)
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


# ── Step 6: Verify result ─────────────────────────────────────

def download_and_summarise(result_url: str) -> None:
    if not result_url:
        return
    print(f"\nDownloading result from: {result_url}")
    resp = requests.get(result_url, timeout=120)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} result lines")

    errors = [l for l in lines if l.get("userErrors")]
    if errors:
        print(f"  ⚠️  {len(errors)} line(s) with userErrors:")
        for e in errors[:10]:
            print(f"      {e}")
    else:
        print(f"  ✅ No userErrors detected — all items unpublished from NTS Storefront.")


# ── Main ──────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Bulk unpublish products/collections from NTS Storefront")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--csv", metavar="FILE", help='CSV file with a "Collection GID" or "Product GID" column')
    src.add_argument("--gids", metavar="FILE", help="Plain-text file with one GID per line")
    
    parser.add_argument("--out", default=os.path.join(BASE_DIR, "output", "unpublish_nts_bulk.jsonl"))
    args = parser.parse_args()

    print("\n── Loading GIDs ──")
    if args.csv:
        csv_path = args.csv if os.path.isabs(args.csv) else os.path.join(BASE_DIR, args.csv)
        gids = load_gids_from_csv(csv_path)
    else:
        txt_path = args.gids if os.path.isabs(args.gids) else os.path.join(BASE_DIR, args.gids)
        gids = load_gids_from_txt(txt_path)

    if not gids:
        print("[INFO] No valid GIDs found — nothing to do.")
        sys.exit(0)

    print(f"\n── Building JSONL ({len(gids)} items → Unpublish NTS) ──")
    jsonl_file = args.out if os.path.isabs(args.out) else os.path.join(BASE_DIR, args.out)
    count = build_unpublish_jsonl(gids, jsonl_file)
    if count == 0:
        sys.exit(0)

    print("\n── Creating staged upload ──")
    target = create_staged_upload(os.path.basename(jsonl_file))
    if not target: sys.exit(1)

    print("\n── Uploading JSONL ──")
    resource_url = upload_jsonl(target, jsonl_file)

    print("\n── Running bulk mutation (publishableUnpublish) ──")
    op = run_bulk_mutation(resource_url)
    if not op: sys.exit(1)

    print("\n── Polling bulk operation ──")
    result_url = poll_status()

    if result_url:
        download_and_summarise(result_url)
        print(f"\n{'='*50}\n✅ Bulk unpublish done! {count} item(s) removed from NTS Storefront.\nResult URL: {result_url}")
    else:
        print("\n❌ Bulk operation did not complete successfully.")
        sys.exit(1)

if __name__ == "__main__":
    main()
