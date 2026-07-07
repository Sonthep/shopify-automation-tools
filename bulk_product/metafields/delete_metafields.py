"""
Delete Shopify metafield definitions in bulk from a CSV file.

CSV format (data/delete_metafield_definitions.csv):
    namespace, key, delete_data
    (delete_data = true/false — ถ้า true จะลบค่า metafield ทุก product ที่มีด้วย)

Example rows:
    specs,voltage,false
    specs,power_watt,true
    custom,part_type,false

Usage:
    py delete_metafields.py
    py delete_metafields.py data/my_delete_list.csv
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import csv
import os
import sys
import time

from utils import make_headers, gql, API_URL

HEADERS     = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
base_dir    = os.path.dirname(__file__)
DEFAULT_CSV = os.path.join(base_dir, "data", "delete_metafield_definitions.csv")
OUTPUT_DIR  = os.path.join(base_dir, "output")


# ─────────────────────────────────────────
# STEP 1: Lookup definition ID
# ─────────────────────────────────────────
QUERY_DEF = """
query GetMetafieldDef($namespace: String!, $key: String!) {
  metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: $namespace, key: $key) {
    nodes { id name namespace key }
  }
}
"""


def get_definition_id(namespace: str, key: str) -> str | None:
    body = gql(API_URL, HEADERS, QUERY_DEF, {"namespace": namespace, "key": key})
    nodes = (body or {}).get("data", {}).get("metafieldDefinitions", {}).get("nodes", [])
    if not nodes:
        return None
    return nodes[0]["id"]


# ─────────────────────────────────────────
# STEP 2: Delete definition
# ─────────────────────────────────────────
MUTATION_DELETE = """
mutation DeleteMetafieldDef($id: ID!, $deleteAll: Boolean!) {
  metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: $deleteAll) {
    deletedDefinitionId
    userErrors { field message code }
  }
}
"""


def delete_definition(def_id: str, delete_data: bool) -> dict | None:
    return gql(API_URL, HEADERS, MUTATION_DELETE, {"id": def_id, "deleteAll": delete_data})


def process_result(result: dict, namespace: str, key: str) -> bool:
    key_label = f"{namespace}.{key}"
    data   = (result or {}).get("data", {}).get("metafieldDefinitionDelete", {})
    errors = data.get("userErrors", [])

    if errors:
        for err in errors:
            print(f"  ❌ {key_label}: [{err.get('code')}] {err.get('message')}")
        return False

    deleted_id = data.get("deletedDefinitionId")
    if deleted_id:
        print(f"  ✅ {key_label} deleted (id: {deleted_id})")
        return True

    print(f"  ⚠️  {key_label}: unexpected response — {result}")
    return False


# ─────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────
def main(csv_path: str):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"\n📂 Reading: {csv_path}\n{'─'*50}")

    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        reader.fieldnames = [h.strip() for h in reader.fieldnames]
        rows = list(reader)

    print(f"Found {len(rows)} rows\n")

    # Safety confirmation
    confirm = input(f"⚠️  Delete {len(rows)} metafield definition(s)? (yes/no): ")
    if confirm.strip().lower() != "yes":
        print("❌ Cancelled.")
        sys.exit(0)
    print()

    success_count = 0
    fail_count    = 0
    skip_count    = 0
    failed_rows   = []

    for i, row in enumerate(rows, start=1):
        namespace   = row.get("namespace", "").strip()
        key         = row.get("key", "").strip()
        delete_data = str(row.get("delete_data", "false")).strip().lower() in ("true", "1", "yes")

        print(f"[{i}/{len(rows)}] {namespace}.{key} (delete_data={delete_data})")

        if not namespace or not key:
            print(f"  ⚠️  Missing namespace or key — skipped")
            skip_count += 1
            continue

        # Look up definition ID
        def_id = get_definition_id(namespace, key)
        if not def_id:
            print(f"  ⚠️  Definition not found — skipped")
            skip_count += 1
            continue

        result = delete_definition(def_id, delete_data)
        ok = process_result(result, namespace, key) if result else False

        if ok:
            success_count += 1
        else:
            fail_count += 1
            failed_rows.append(row)

        time.sleep(0.5)

    # Save failed rows
    if failed_rows:
        failed_path = os.path.join(OUTPUT_DIR, "metafields_delete_failed.csv")
        with open(failed_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(failed_rows)
        print(f"\n⚠️  Failed rows saved → output/metafields_delete_failed.csv")

    print(f"\n{'─'*50}")
    print(f"✅ Deleted : {success_count}")
    print(f"❌ Failed  : {fail_count}")
    print(f"⏭️  Skipped : {skip_count}")
    print(f"{'─'*50}\n")


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    if not os.path.exists(csv_path):
        print(f"❌ CSV not found: {csv_path}")
        print(f"   Create it at: data/delete_metafield_definitions.csv")
        print(f"   Columns: namespace, key, delete_data")
        sys.exit(1)
    main(csv_path)
