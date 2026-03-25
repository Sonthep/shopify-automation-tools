import requests
import pandas as pd
import json
import time
import os
from dotenv import load_dotenv

load_dotenv()

SHOP  = os.getenv("SHOP_NAME")
TOKEN = os.getenv("SHOPIFY_ACCESS_TOKEN_IMPORT_PRODUCT")
print(f"SHOP: {SHOP}")
print(f"TOKEN: {TOKEN[:10]}..." if TOKEN else "TOKEN: None")

HEADERS  = {"Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN}
API_URL  = f"https://{SHOP}/admin/api/2025-01/graphql.json"

# ── Column mapping (CSV header → Shopify field) ───────────────
COL = {
    "sku":              "Variant SKU",
    "title":            "Title",
    "body_html":        "Body (HTML)",
    "vendor":           "Vendor",
    "product_type":     "Product Type",
    "tags":             "Tags",
    "status":           "Status",
    "price":            "Price",
    "compare_at_price": "Compare At Price",
}


# ── Resolve SKU → Product GID ─────────────────────────────────
def get_product_gids_by_skus(skus, batch_size=50):
    gid_map = {}
    for i in range(0, len(skus), batch_size):
        batch = skus[i:i+batch_size]
        aliases = "\n".join([
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") {{ edges {{ node {{ product {{ id }} }} }} }}'
            for j, sku in enumerate(batch)
        ])
        res  = requests.post(API_URL, json={"query": f"{{ {aliases} }}"}, headers=HEADERS)
        data = res.json().get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            gid_map[sku] = edges[0]["node"]["product"]["id"] if edges else None
        print(f"  Resolved {min(i+batch_size, len(skus))}/{len(skus)} SKUs")
        time.sleep(0.5)
    return gid_map


# ── Helper: safe get value from row ──────────────────────────
def get_val(row, col_name):
    if col_name not in row.index:
        return None
    val = row[col_name]
    if pd.isna(val):
        return None
    return str(val).strip()


# ── Build JSONL ───────────────────────────────────────────────
def build_jsonl(csv_file, jsonl_file):
    df = pd.read_csv(csv_file)
    print(f"Columns found: {df.columns.tolist()}")

    sku_col = COL["sku"] if COL["sku"] in df.columns else "sku"
    if sku_col not in df.columns:
        print(f"❌ Cannot find SKU column. Available: {df.columns.tolist()}")
        return 0

    skus = df[sku_col].dropna().tolist()
    print(f"📋 {len(skus)} SKUs found")

    gid_map   = get_product_gids_by_skus(skus)
    not_found = [s for s, g in gid_map.items() if g is None]
    if not_found:
        print(f"⚠️ Not found: {not_found}")
        pd.DataFrame({"sku": not_found}).to_csv("not_found.csv", index=False)

    count = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            sku = row[sku_col]
            gid = gid_map.get(sku)
            if not gid:
                continue

            input_data = {"id": gid}

            if v := get_val(row, COL["title"]):
                input_data["title"] = v

            if v := get_val(row, COL["body_html"]):
                input_data["bodyHtml"] = v

            if v := get_val(row, COL["vendor"]):
                input_data["vendor"] = v

            if v := get_val(row, COL["product_type"]):
                input_data["productType"] = v

            if v := get_val(row, COL["tags"]):
                input_data["tags"] = [t.strip() for t in v.split(",")]

            if v := get_val(row, COL["status"]):
                input_data["status"] = v.upper()

            # ── Variants (price / compare_at_price) ──
            price         = get_val(row, COL["price"])
            compare_price = get_val(row, COL["compare_at_price"])
            if price or compare_price:
                variant = {}
                if price:
                    variant["price"] = price
                if compare_price:
                    variant["compareAtPrice"] = compare_price
                input_data["variants"] = [variant]

            if len(input_data) <= 1:
                continue

            payload = {"input": input_data}
            f.write(json.dumps(payload) + "\n")
            count += 1

    print(f"✅ {count} rows → {jsonl_file}")
    return count


# ── Staged Upload ─────────────────────────────────────────────
def create_staged_upload():
    query = """
    mutation {
      stagedUploadsCreate(input: {
        resource: BULK_MUTATION_VARIABLES,
        filename: "bulk.jsonl",
        mimeType: "text/jsonl",
        httpMethod: PUT
      }) {
        stagedTargets {
          url resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
    """
    res  = requests.post(API_URL, json={"query": query}, headers=HEADERS)
    data = res.json()["data"]["stagedUploadsCreate"]
    if data.get("userErrors"):
        print(f"❌ stagedUploadsCreate error: {data['userErrors']}")
        return None
    target = data["stagedTargets"][0]
    print(f"✅ Staged upload created: {target['resourceUrl']}")
    return target


# ── Upload JSONL via PUT ──────────────────────────────────────
def upload_jsonl(target, filepath):
    with open(filepath, "rb") as f:
        res = requests.put(
            target["url"],
            data=f,
            headers={"Content-Type": "text/jsonl"}
        )
    print(f"Upload status: {res.status_code}")
    res.raise_for_status()
    print(f"✅ Uploaded: {filepath}")
    return target["resourceUrl"]


# ── Run Bulk Mutation ─────────────────────────────────────────
def run_bulk_mutation(resource_url):
    mutation = """
    mutation bulkUpdate($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id title }
            userErrors { field message }
          }
        }",
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }"""
    res = requests.post(API_URL,
                        json={"query": mutation,
                              "variables": {"stagedUploadPath": resource_url}},
                        headers=HEADERS)
    op = res.json()["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"❌ {op['userErrors']}")
        return None
    print(f"✅ Started: {op['bulkOperation']['id']}")
    return op


# ── Poll Status ───────────────────────────────────────────────
def poll_status(interval=15):
    query = """{ currentBulkOperation(type: MUTATION) {
        id status errorCode objectCount url } }"""
    while True:
        res = requests.post(API_URL, json={"query": query}, headers=HEADERS)
        op  = res.json()["data"].get("currentBulkOperation")
        if op is None:
            print("No active bulk operation found.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows")
        if op["status"] == "COMPLETED":
            return op["url"]
        elif op["status"] in ["FAILED", "CANCELED"]:
            print(f"❌ {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    base_dir   = os.path.dirname(__file__)
    CSV_FILE   = os.path.join(base_dir, "test.csv")
    JSONL_FILE = os.path.join(base_dir, "bulk.jsonl")

    print(f"Using CSV: {CSV_FILE}")
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
        print("Bulk mutation did not start. Exiting.")
        exit(1)

    result_url = poll_status()
    print(f"🎉 Done! Result: {result_url}")
