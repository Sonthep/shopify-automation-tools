"""
Bulk-update a metafield on products using Shopify Bulk Mutation API.

CSV format (columns):
    Variant SKU   - SKU ของสินค้า
    part_type     - ค่าที่ต้องการใส่ใน metafield custom.part_type

Workflow:
    1. อ่าน CSV → resolve SKU → product GID
       (ถ้ามี product_gids.json จะใช้ cache แทน query API)
    2. สร้าง JSONL
    3. Staged upload → run bulk mutation → poll จนเสร็จ

Usage:
    py update_metafield.py
"""
import json
import time
import os
import requests
import pandas as pd
from utils import make_headers, gql, get_product_gids_by_skus, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# ── Config ────────────────────────────────────────────────────
CSV_FILE       = os.path.join(os.path.dirname(__file__), "data", "update_power_type.csv")
JSONL_FILE     = os.path.join(os.path.dirname(__file__), "output", "part_type_bulk.jsonl")
GID_CACHE_FILE = os.path.join(os.path.dirname(__file__), "cache", "product_gids.json")
COL_SKU        = "Variant SKU"

# metafield columns to update: (csv_column, namespace, key, type)
METAFIELD_COLS = [
    ("part_type",  "custom", "part_type",  "single_line_text_field"),
    ("power_type", "custom", "power_type", "single_line_text_field"),
]


# ── Build JSONL ───────────────────────────────────────────────
def build_jsonl(csv_file: str, jsonl_file: str) -> int:
    df = pd.read_csv(csv_file)
    print(f"Columns: {df.columns.tolist()}")

    if COL_SKU not in df.columns:
        print(f"❌ Column '{COL_SKU}' not found. Available: {df.columns.tolist()}")
        return 0

    # only keep metafield columns that actually exist in the CSV
    active_cols = [(col, ns, key, typ) for col, ns, key, typ in METAFIELD_COLS if col in df.columns]
    missing = [col for col, *_ in METAFIELD_COLS if col not in df.columns]
    if missing:
        print(f"⚠️  Columns not in CSV (skipped): {missing}")
    if not active_cols:
        print("❌ No metafield columns found in CSV.")
        return 0

    df = df.dropna(subset=[COL_SKU])
    skus = df[COL_SKU].astype(str).str.strip().tolist()
    print(f"📋 {len(skus)} rows to update ({[c for c, *_ in active_cols]})")

    gid_map = get_product_gids_by_skus(API_URL, HEADERS, skus, cache_file=GID_CACHE_FILE)
    not_found = [s for s, g in gid_map.items() if g is None]
    if not_found:
        print(f"⚠️  Not found ({len(not_found)}): {not_found[:10]}")
        pd.DataFrame({"sku": not_found}).to_csv(os.path.join(os.path.dirname(__file__), "output", "not_found_metafield.csv"), index=False)

    count = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            sku = str(row[COL_SKU]).strip()
            gid = gid_map.get(sku)
            if not gid:
                continue
            metafields = []
            for col, ns, key, typ in active_cols:
                val = row.get(col)
                if pd.notna(val) and str(val).strip():
                    metafields.append({
                        "namespace": ns,
                        "key": key,
                        "value": str(val).strip(),
                        "type": typ,
                    })
            if not metafields:
                continue
            line = {"input": {"id": gid, "metafields": metafields}}
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
            count += 1

    print(f"✅ {count} rows → {jsonl_file}")
    return count


# ── Staged Upload ─────────────────────────────────────────────
def create_staged_upload(jsonl_file: str) -> dict | None:
    filename = os.path.basename(jsonl_file)
    MUTATION = """
    mutation stagedUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
    """
    variables = {"input": [{
        "resource": "BULK_MUTATION_VARIABLES",
        "filename": filename,
        "mimeType": "text/jsonl",
        "httpMethod": "PUT",
    }]}
    body = gql(API_URL, HEADERS, MUTATION, variables)
    if not body:
        return None
    data = body["data"]["stagedUploadsCreate"]
    if data["userErrors"]:
        print(f"❌ stagedUploadsCreate: {data['userErrors']}")
        return None
    target = data["stagedTargets"][0]
    print(f"✅ Staged upload created")
    return target


def upload_jsonl(target: dict, jsonl_file: str) -> str | None:
    with open(jsonl_file, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    print(f"Upload status: {res.status_code}")
    res.raise_for_status()
    return target["resourceUrl"]


# ── Run Bulk Mutation ─────────────────────────────────────────
def run_bulk_mutation(resource_url: str) -> bool:
    MUTATION = """
    mutation bulkUpdate($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation updateMeta($input: ProductInput!) { productUpdate(input: $input) { product { id } userErrors { field message } } }"
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
    """
    body = gql(API_URL, HEADERS, MUTATION, {"stagedUploadPath": resource_url})
    if not body:
        return False
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"❌ {op['userErrors']}")
        return False
    print(f"✅ Bulk operation started: {op['bulkOperation']['id']}")
    return True


# ── Poll Status ───────────────────────────────────────────────
def poll_status(interval: int = 15) -> str | None:
    QUERY = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"
    while True:
        body = gql(API_URL, HEADERS, QUERY)
        if not body:
            print("❌ Failed to poll status.")
            return None
        op = body["data"].get("currentBulkOperation")
        if op is None:
            print("No active bulk operation.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows")
        if op["status"] == "COMPLETED":
            print(f"✅ Done! {op['objectCount']} metafields updated")
            return op.get("url")
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"❌ {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    os.makedirs(os.path.join(os.path.dirname(__file__), "output"), exist_ok=True)
    os.makedirs(os.path.join(os.path.dirname(__file__), "cache"), exist_ok=True)
    count = build_jsonl(CSV_FILE, JSONL_FILE)
    if count == 0:
        print("Nothing to update.")
        raise SystemExit(1)

    target = create_staged_upload(JSONL_FILE)
    if not target:
        raise SystemExit(1)

    resource_url = upload_jsonl(target, JSONL_FILE)
    if not run_bulk_mutation(resource_url):
        raise SystemExit(1)

    poll_status()
