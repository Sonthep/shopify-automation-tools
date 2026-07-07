import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import time

import requests
import pandas as pd

from utils import make_headers, gql, read_csv_auto, API_URL, get_val

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

GID_COLUMN = "Product GID"

def build_jsonl(df: pd.DataFrame, out_jsonl: str) -> int:
    """Build JSONL file for clearing productType and all tags."""
    if GID_COLUMN not in df.columns:
        print(f"[ERR] Need '{GID_COLUMN}' in CSV.")
        sys.exit(1)

    count = 0
    os.makedirs(os.path.dirname(out_jsonl), exist_ok=True)

    with open(out_jsonl, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            gid = get_val(row, GID_COLUMN)
            if not gid:
                continue

            # Clear Product Type and clear ALL tags
            payload = {
                "input": {
                    "id": gid,
                    "productType": "",
                    "tags": []
                }
            }
            f.write(json.dumps(payload) + "\n")
            count += 1

    print(f"  {count} rows written -> {out_jsonl}")
    return count


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


def run_bulk_mutation(resource_url: str) -> dict | None:
    mutation = """
    mutation BulkUpdateTypeAndTags($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation clearTypeAndTags($input: ProductInput!) { productUpdate(input: $input) { product { id productType tags } userErrors { field message } } }",
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


def main():
    parser = argparse.ArgumentParser(description="Bulk remove productType and ALL tags")
    parser.add_argument("--csv", required=True, help="CSV file with Product GID")
    parser.add_argument("--dry-run", action="store_true", help="Build JSONL only")
    args = parser.parse_args()

    # Resolve CSV path
    if os.path.exists(args.csv):
        csv_path = args.csv
    else:
        csv_path = os.path.join(os.path.dirname(BASE_DIR), args.csv)
    df = read_csv_auto(csv_path)

    out_jsonl = os.path.join(BASE_DIR, "output", "clear_type_tags.jsonl")

    count = build_jsonl(df, out_jsonl)

    if args.dry_run:
        print("[DRY RUN] Finished building JSONL files.")
        return

    if count > 0:
        print("\n── 1. Clearing Product Type & Tags ──")
        target = create_staged_upload("clear_type_tags.jsonl")
        if target:
            res_url = upload_jsonl(target, out_jsonl)
            if run_bulk_mutation(res_url):
                res = poll_status()
                print(f"Update done! Result URL: {res}")

if __name__ == "__main__":
    main()
