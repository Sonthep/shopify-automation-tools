import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
import csv
import json
import time
import os
import requests
import pandas as pd
from utils import make_headers, get_product_gids_by_skus, gql, read_csv_auto, API_URL

# Fix Unicode/emoji output on Windows terminals (e.g. CP874)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ===== CONFIG =====
LOCALE = "th"

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
ENDPOINT = API_URL

base_dir    = os.path.dirname(__file__)
CSV_FILE    = os.path.join(base_dir, "data/update_data_thai1.csv")
JSONL_FILE  = os.path.join(base_dir, "output", "bulk.jsonl")
LOG_FILE    = os.path.join(base_dir, "output", "upload_log.csv")

# Shopify translation key → CSV column name
COL = {
    "title":            "title",
    "body_html":        "Body (HTML)",
    "meta_title":       "meta_title",
    "meta_description": "meta_description",
}
SKU_COL = "Variant SKU"


def graphql(query, variables=None):
    """Thin wrapper around utils.gql that uses module-level ENDPOINT/HEADERS."""
    return gql(ENDPOINT, HEADERS, query, variables)


# ===== STEP 1: Get Digests (batched via aliases) =====
BATCH_SIZE_DIGEST = 50  # products per request

def get_digests_batch(product_gids: list, batch_size: int = BATCH_SIZE_DIGEST) -> dict:
    """Fetch translatableContent digests for many products in batched alias queries.
    Returns: { product_gid: { key: digest, ... }, ... }
    """
    all_digests = {}
    total = len(product_gids)
    for i in range(0, total, batch_size):
        batch = product_gids[i:i + batch_size]
        aliases = "\n".join([
            f'r{j}: translatableResource(resourceId: "{gid}") '
            f'{{ translatableContent {{ key digest }} }}'
            for j, gid in enumerate(batch)
        ])
        result = graphql(f"{{ {aliases} }}")
        if result is None or result.get("errors"):
            print(f"  ❌ Digest batch error: {(result or {}).get('errors')}")
            for gid in batch:
                all_digests[gid] = {}
            continue
        data = result.get("data", {})
        for j, gid in enumerate(batch):
            resource = data.get(f"r{j}")
            if resource:
                all_digests[gid] = {item["key"]: item["digest"]
                                    for item in resource["translatableContent"]}
            else:
                all_digests[gid] = {}
        fetched = min(i + batch_size, total)
        print(f"  Fetched digests {fetched}/{total}")
        time.sleep(0.3)
    return all_digests


# ===== STEP 2: Staged Upload =====
CREATE_STAGED_UPLOAD = """
mutation CreateStagedUpload {
  stagedUploadsCreate(input: {
    resource: BULK_MUTATION_VARIABLES
    filename: "bulk.jsonl"
    mimeType: "text/jsonl"
    httpMethod: POST
  }) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}
"""

def create_staged_upload():
    result = graphql(CREATE_STAGED_UPLOAD)
    target = result["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    params = {p["name"]: p["value"] for p in target["parameters"]}
    print(f"✅ Staged upload target: {target['resourceUrl']}")
    print(f"   GCS key: {params.get('key')}")
    return target


def upload_jsonl(target, jsonl_path):
    params = {p["name"]: p["value"] for p in target["parameters"]}
    with open(jsonl_path, "rb") as f:
        r = requests.post(target["url"], data=params, files={"file": f})
    r.raise_for_status()
    print(f"✅ JSONL uploaded to staged storage")
    # Shopify bulkOperationRunMutation expects the GCS key path, not the full resourceUrl
    staged_path = params.get("key", target["resourceUrl"])
    print(f"   stagedUploadPath will be: {staged_path}")
    return staged_path


# ===== STEP 3: Run Bulk Mutation =====
RUN_BULK = """
mutation RunBulkTranslation($stagedUploadPath: String!) {
  bulkOperationRunMutation(
    mutation: \"\"\"
      mutation RegisterTranslation($input: TranslationInput!, $resourceId: ID!) {
        translationsRegister(resourceId: $resourceId, translations: [$input]) {
          translations { key locale }
          userErrors { field message }
        }
      }
    \"\"\",
    stagedUploadPath: $stagedUploadPath
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
"""

def run_bulk_mutation(resource_url):
    print(f"  Using stagedUploadPath: {resource_url}")
    result = graphql(RUN_BULK, {"stagedUploadPath": resource_url})
    if result is None:
        print("❌ run_bulk_mutation: no response from API")
        return None
    bulk_result = result.get("data", {}).get("bulkOperationRunMutation", {})
    errors = bulk_result.get("userErrors", [])
    if errors:
        print(f"❌ bulkOperationRunMutation userErrors: {errors}")
        return None
    op = bulk_result.get("bulkOperation")
    if op is None:
        print(f"❌ bulkOperation is None. Full response: {json.dumps(result, ensure_ascii=False)[:1000]}")
        return None
    print(f"✅ Bulk operation started: {op['id']} | Status: {op['status']}")
    return op


# ===== STEP 4: Poll Status =====
POLL_STATUS = """
query BulkOperationStatus {
  currentBulkOperation(type: MUTATION) {
    id status errorCode
    objectCount completedAt
  }
}
"""

def poll_until_done(interval=5):
    print("⏳ Polling bulk operation status...")
    while True:
        result = graphql(POLL_STATUS)
        op = result["data"]["currentBulkOperation"]
        status = op["status"]
        print(f"   Status: {status} | Objects: {op['objectCount']}")
        if status in ("COMPLETED", "FAILED", "CANCELED"):
            if status != "COMPLETED":
                print(f"❌ Bulk operation ended with: {status} | Error: {op['errorCode']}")
            else:
                print(f"🎉 Completed! Total objects: {op['objectCount']}")
            break
        time.sleep(interval)


# ===== BUILD JSONL FROM CSV =====
def build_jsonl(csv_path, jsonl_path):
    df = read_csv_auto(csv_path)
    print(f"Columns found: {df.columns.tolist()}")

    if SKU_COL not in df.columns:
        print(f"❌ Cannot find SKU column '{SKU_COL}'. Available: {df.columns.tolist()}")
        return 0

    skus = df[SKU_COL].dropna().unique().tolist()
    print(f"📋 {len(skus)} unique SKUs found")

    gid_map = get_product_gids_by_skus(ENDPOINT, HEADERS, skus)
    not_found = [s for s, g in gid_map.items() if g is None]
    if not_found:
        print(f"⚠️  Not found: {not_found}")

    rows_written = 0
    log_rows = []

    # Pre-fetch all digests in batches (much faster than one-by-one)
    valid_gids = [gid for gid in [gid_map.get(s) for s in skus] if gid]
    print(f"🔍 Fetching digests for {len(valid_gids)} products in batches...")
    digest_map = get_digests_batch(valid_gids)

    with open(jsonl_path, "w", encoding="utf-8") as jsonlfile:
        for _, row in df.iterrows():
            sku = row[SKU_COL]
            product_gid = gid_map.get(sku)
            if not product_gid:
                log_rows.append({"product_gid": sku, "status": "NOT_FOUND"})
                continue

            digests = digest_map.get(product_gid, {})
            if not digests:
                print(f"  ⚠ No digests for {product_gid} (SKU: {sku})")
                log_rows.append({"product_gid": product_gid, "status": "NO_DIGEST"})
                continue

            for field, csv_col in COL.items():
                if csv_col not in df.columns or field not in digests:
                    continue
                raw = row.get(csv_col)
                if pd.isna(raw):
                    continue
                value = str(raw).strip()
                if not value:
                    continue
                entry = {
                    "resourceId": product_gid,
                    "input": {
                        "key": field,
                        "value": value,
                        "locale": LOCALE,
                        "translatableContentDigest": digests[field],
                    },
                }
                jsonlfile.write(json.dumps(entry, ensure_ascii=False) + "\n")
                rows_written += 1

            log_rows.append({"product_gid": product_gid, "status": "QUEUED"})

    # Write log
    with open(LOG_FILE, "w", newline="", encoding="utf-8") as logfile:
        writer = csv.DictWriter(logfile, fieldnames=["product_gid", "status"])
        writer.writeheader()
        writer.writerows(log_rows)

    print(f"\n📄 JSONL ready: {rows_written} translation entries → {jsonl_path}")
    return rows_written


# ===== MAIN =====
if __name__ == "__main__":
    print(f"Using CSV:   {CSV_FILE}")
    print(f"Using JSONL: {JSONL_FILE}")

    count = build_jsonl(CSV_FILE, JSONL_FILE)
    if count == 0:
        print("No rows to process.")
        exit()

    target = create_staged_upload()
    if not target:
        exit(1)

    resource_url = upload_jsonl(target, JSONL_FILE)
    op = run_bulk_mutation(resource_url)
    if not op:
        print("❌ Bulk mutation failed to start. See errors above.")
        exit(1)
    poll_until_done(interval=5)
