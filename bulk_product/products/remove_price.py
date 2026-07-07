import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import time

import requests
import pandas as pd

from utils import make_headers, gql, read_csv_auto, get_val, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

BULK_MUTATION = """
mutation {
  bulkOperationRunMutation(
    mutation: "mutation variantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }",
    stagedUploadPath: "%s"
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
"""

POLL_QUERY = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"

def create_staged_upload(filename: str = "remove_price.jsonl") -> dict | None:
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
        print(f"stagedUploadsCreate error: {data['userErrors']}")
        return None
    target = data["stagedTargets"][0]
    return target

def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"Uploaded: {filepath} (HTTP {res.status_code})")
    return target["resourceUrl"]

def start_bulk_mutation(staged_path: str) -> str | None:
    query = BULK_MUTATION % staged_path
    body  = gql(API_URL, HEADERS, query)
    if not body:
        return None
    op_data = body["data"]["bulkOperationRunMutation"]
    if op_data.get("userErrors"):
        print(f"[ERROR] {op_data['userErrors']}")
        return None
    op_id = op_data["bulkOperation"]["id"]
    print(f"Bulk operation started: {op_id}")
    return op_id

def poll_status(interval: int = 5) -> str | None:
    while True:
        body = gql(API_URL, HEADERS, POLL_QUERY)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
        if not op:
            print("[ERROR] No active bulk operation.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows")
        if op["status"] == "COMPLETED":
            return op.get("url")
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[ERROR] {op['errorCode']}")
            return None
        time.sleep(interval)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, help="Path to CSV file (must contain Product GID and Variant GID)")
    args = parser.parse_args()

    base_dir = os.path.dirname(__file__)
    if os.path.exists(args.csv):
        CSV_FILE = args.csv
    else:
        CSV_FILE = os.path.join(os.path.dirname(base_dir), args.csv)
        
    JSONL_FILE = os.path.join(base_dir, "output", "remove_price.jsonl")
    os.makedirs(os.path.dirname(JSONL_FILE), exist_ok=True)

    print(f"Using CSV: {CSV_FILE}")
    df = read_csv_auto(CSV_FILE)

    count = 0
    with open(JSONL_FILE, "w", encoding="utf-8") as f:
        for idx, row in df.iterrows():
            product_gid = get_val(row, "Product GID")
            variant_gid = get_val(row, "Variant GID")

            if product_gid and variant_gid:
                payload = {
                    "productId": product_gid,
                    "variants": [
                        {
                            "id": variant_gid,
                            "price": "0.00",
                            "compareAtPrice": None
                        }
                    ]
                }
                f.write(json.dumps(payload) + "\n")
                count += 1

    if count == 0:
        print("No valid Product GID / Variant GID found in CSV.")
        return

    print(f"Generated {count} operations -> {JSONL_FILE}")
    
    print("Uploading JSONL to Shopify...")
    target = create_staged_upload()
    if not target:
        return
    staged_path = upload_jsonl(target, JSONL_FILE)
    if not staged_path:
        return
        
    op = start_bulk_mutation(staged_path)
    if op:
        print("Polling...")
        result_url = poll_status()
        print(f"All done! Result URL: {result_url}")

if __name__ == "__main__":
    main()
