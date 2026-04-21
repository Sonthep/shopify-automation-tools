"""
Bulk-update metafield values on products from a CSV file.

CSV format:
    - Column 1       : "GID"  (e.g. gid://shopify/Product/123456789)
    - "descriptionHtml": (optional) HTML description ของ product
    - Remaining        : metafield columns named as  "namespace.key"
                         e.g.  specs.voltage, specs.weight_kg, custom.part_type

    Leave a cell blank to skip that field for that row.

Example CSV:
    GID,descriptionHtml,specs.voltage,custom.part_type
    gid://shopify/Product/123456789,<p>New desc</p>,220,Compressor
    gid://shopify/Product/987654321,,380,

Workflow:
    1. อ่าน CSV → แยก namespace/key จาก column header
    2. Query metafield definitions เพื่อดึง type (number_integer ฯลฯ)
    3. ใช้ GID จาก CSV โดยตรง (ไม่ต้อง resolve SKU)
    4. Build JSONL → Staged upload → Bulk mutation → Poll

Usage:
    py update_metafields_value.py
    py update_metafields_value.py data/update_specs.csv
"""
import json
import os
import sys
import time

import pandas as pd
import requests

from utils import make_headers, gql, read_csv_auto, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

base_dir    = os.path.dirname(__file__)
DEFAULT_CSV = os.path.join(base_dir, "data", "test_update_metafields_value.csv")
JSONL_FILE  = os.path.join(base_dir, "output", "metafields_value_bulk.jsonl")
GID_COL     = "GID"
DESC_COL    = "descriptionHtml"


# ── Step 1: Fetch metafield definition types ──────────────────
QUERY_DEFS = """
query GetDefs($ownerType: MetafieldOwnerType!) {
  metafieldDefinitions(first: 250, ownerType: $ownerType) {
    nodes { namespace key type { name } }
  }
}
"""


def fetch_definition_types() -> dict:
    """Returns { "namespace.key": "type_name", ... }"""
    body = gql(API_URL, HEADERS, QUERY_DEFS, {"ownerType": "PRODUCT"})
    nodes = (body or {}).get("data", {}).get("metafieldDefinitions", {}).get("nodes", [])
    result = {f"{n['namespace']}.{n['key']}": n["type"]["name"] for n in nodes}
    print(f"  Fetched {len(result)} metafield definitions")
    return result


# ── Step 2: Build JSONL ───────────────────────────────────────
def build_jsonl(csv_file: str, jsonl_file: str) -> int:
    df = read_csv_auto(csv_file, dtype=str)
    print(f"Columns: {df.columns.tolist()}")

    if GID_COL not in df.columns:
        print(f"❌ Column '{GID_COL}' not found.")
        return 0

    has_desc  = DESC_COL in df.columns

    # Parse metafield columns (must be "namespace.key" format)
    skip_cols = {GID_COL, DESC_COL}
    meta_cols = [c for c in df.columns if c not in skip_cols and "." in c]
    if not meta_cols and not has_desc:
        print("❌ No updatable columns found. Add 'descriptionHtml' and/or metafield columns named 'namespace.key'")
        return 0

    ignored = [c for c in df.columns if c not in skip_cols and "." not in c]
    if ignored:
        print(f"⚠️  Ignored columns (no namespace.key format): {ignored}")
    if has_desc:
        print(f"  Description column: {DESC_COL}")

    print(f"  Metafield columns: {meta_cols}")

    # Fetch types from Shopify
    print("\nFetching metafield definition types...")
    type_map = fetch_definition_types()

    # Assign type to each column — default to single_line_text_field if not defined yet
    col_info: list[tuple[str, str, str, str]] = []  # (col, namespace, key, type)
    for col in meta_cols:
        parts = col.split(".", 1)
        ns, key = parts[0].strip(), parts[1].strip()
        mf_type = type_map.get(col, "single_line_text_field")
        if col not in type_map:
            print(f"  ⚠️  Definition not found for '{col}' — using single_line_text_field")
        col_info.append((col, ns, key, mf_type))

    df = df.dropna(subset=[GID_COL])
    print(f"\n📋 {len(df)} rows to process")

    os.makedirs(os.path.dirname(jsonl_file), exist_ok=True)
    count = 0

    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            gid = str(row[GID_COL]).strip()
            if not gid:
                continue

            metafields = []
            for col, ns, key, mf_type in col_info:
                val = row.get(col)
                if pd.isna(val) or str(val).strip() == "":
                    continue
                raw = str(val).strip()
                # list.* types require a JSON array string e.g. ["val1","val2"]
                if mf_type.startswith("list."):
                    import ast
                    try:
                        parsed = ast.literal_eval(raw)
                        if not isinstance(parsed, list):
                            parsed = [raw]
                    except Exception:
                        parsed = [item.strip() for item in raw.split(",") if item.strip()]
                    formatted = json.dumps(parsed, ensure_ascii=False)
                else:
                    formatted = raw
                metafields.append({
                    "namespace": ns,
                    "key":       key,
                    "value":     formatted,
                    "type":      mf_type,
                })

            desc_val = None
            if has_desc:
                raw_desc = row.get(DESC_COL)
                if pd.notna(raw_desc) and str(raw_desc).strip():
                    desc_val = str(raw_desc).strip()

            if not metafields and desc_val is None:
                continue

            input_obj = {"id": gid}
            if desc_val is not None:
                input_obj["descriptionHtml"] = desc_val
            if metafields:
                input_obj["metafields"] = metafields

            f.write(json.dumps({"input": input_obj}, ensure_ascii=False) + "\n")
            count += 1

    print(f"\n✅ {count} rows → {jsonl_file}")
    return count


# ── Step 3: Staged Upload ─────────────────────────────────────
def create_staged_upload(filename: str) -> dict | None:
    body = gql(API_URL, HEADERS, f"""
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
    }}""")
    if not body:
        return None
    data = body["data"]["stagedUploadsCreate"]
    if data.get("userErrors"):
        print(f"❌ {data['userErrors']}")
        return None
    return data["stagedTargets"][0]


def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"Uploaded (HTTP {res.status_code})")
    return target["resourceUrl"]


# ── Step 4: Bulk Mutation ─────────────────────────────────────
def run_bulk_mutation(resource_url: str) -> bool:
    body = gql(API_URL, HEADERS, """
    mutation bulkMeta($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation updateMeta($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id }
            userErrors { field message }
          }
        }",
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }""", {"stagedUploadPath": resource_url})
    if not body:
        return False
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"❌ {op['userErrors']}")
        return False
    print(f"Bulk operation started: {op['bulkOperation']['id']}")
    return True


def poll_status(interval: int = 15) -> bool:
    query = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount } }"
    while True:
        body = gql(API_URL, HEADERS, query)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print("No active bulk operation.")
            return False
        print(f"  [{op['status']}] {op['objectCount']} rows")
        if op["status"] == "COMPLETED":
            print(f"✅ Done! {op['objectCount']} products updated")
            return True
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"❌ {op['errorCode']}")
            return False
        time.sleep(interval)


# ── Main ─────────────────────────────────────────────────────
if __name__ == "__main__":
    csv_file = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV

    if not os.path.exists(csv_file):
        print(f"❌ CSV not found: {csv_file}")
        print(f"   Create it at: data/update_metafields_value.csv")
        print(f"   Columns: GID, specs.voltage, specs.weight_kg, ...")
        sys.exit(1)

    os.makedirs(os.path.join(base_dir, "output"), exist_ok=True)

    count = build_jsonl(csv_file, JSONL_FILE)
    if count == 0:
        print("Nothing to update.")
        sys.exit(1)

    target = create_staged_upload(os.path.basename(JSONL_FILE))
    if not target:
        sys.exit(1)

    resource_url = upload_jsonl(target, JSONL_FILE)
    if not run_bulk_mutation(resource_url):
        sys.exit(1)

    poll_status()
