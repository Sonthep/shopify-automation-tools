"""
Create Shopify metafield definitions in bulk from a CSV file.

CSV format (data/metafield_definitions.csv):
    name, namespace, key, type, description, filterable

Example rows:
    Voltage (V),specs,voltage,number_integer,Electrical voltage in volts,true
    Weight (kg),specs,weight_kg,number_decimal,Product weight in kilograms,true
    Power Type,specs,power_type,single_line_text_field,Electric or Gas,true

Usage:
    py create_metafields.py
    py create_metafields.py data/my_definitions.csv
"""
import csv
import os
import sys
import time

from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

base_dir     = os.path.dirname(__file__)
DEFAULT_CSV  = os.path.join(base_dir, "data", "metafield_definitions_berjaya.csv")
OUTPUT_DIR   = os.path.join(base_dir, "output")

VALID_TYPES = {
    "number_integer",
    "number_decimal",
    "single_line_text_field",
    "multi_line_text_field",
    "boolean",
    "date",
    "date_time",
    "url",
    "json",
    "color",
    "weight",
    "volume",
    "dimension",
    "rating",
}

MUTATION = """
mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition {
      id
      name
      namespace
      key
      type { name }
    }
    userErrors {
      field
      message
      code
    }
  }
}
"""


# ─────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────
def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in ("true", "1", "yes")


def validate_row(row: dict, line_num: int) -> bool:
    for field in ("name", "namespace", "key", "type"):
        if not row.get(field, "").strip():
            print(f"  ⚠️  Line {line_num}: missing '{field}' — skipped")
            return False
    if row["type"].strip() not in VALID_TYPES:
        print(f"  ⚠️  Line {line_num}: invalid type '{row['type']}' — skipped")
        return False
    return True


def create_metafield_definition(row: dict) -> dict | None:
    variables = {
        "definition": {
            "name":                     row["name"].strip(),
            "namespace":                row["namespace"].strip(),
            "key":                      row["key"].strip(),
            "type":                     row["type"].strip(),
            "description":              row.get("description", "").strip(),
            "ownerType":                "PRODUCT",
            "useAsCollectionCondition": parse_bool(row.get("filterable", "false")),
        }
    }
    return gql(API_URL, HEADERS, MUTATION, variables)


def process_result(result: dict, row: dict) -> bool:
    key_label = f"{row['namespace']}.{row['key']}"
    data   = (result or {}).get("data", {}).get("metafieldDefinitionCreate", {})
    errors = data.get("userErrors", [])

    if errors:
        for err in errors:
            print(f"  ❌ {key_label}: [{err.get('code')}] {err.get('message')}")
        return False

    created = data.get("createdDefinition")
    if created:
        print(f"  ✅ {key_label} ({created['type']['name']})")
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

    success_count = 0
    fail_count    = 0
    skip_count    = 0
    failed_rows   = []

    for i, row in enumerate(rows, start=1):
        name = row.get("name", "").strip()
        key  = row.get("key",  "").strip()
        print(f"[{i}/{len(rows)}] {name} ({key})")

        if not validate_row(row, i + 1):
            skip_count += 1
            continue

        result = create_metafield_definition(row)
        ok = process_result(result, row) if result else False

        if ok:
            success_count += 1
        else:
            fail_count += 1
            failed_rows.append(row)

        time.sleep(0.5)  # ~2 req/sec

    # Save failed rows for retry
    if failed_rows:
        failed_path = os.path.join(OUTPUT_DIR, "metafields_failed.csv")
        with open(failed_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(failed_rows)
        print(f"\n⚠️  Failed rows saved → output/metafields_failed.csv")

    print(f"\n{'─'*50}")
    print(f"✅ Success : {success_count}")
    print(f"❌ Failed  : {fail_count}")
    print(f"⏭️  Skipped : {skip_count}")
    print(f"{'─'*50}\n")


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    if not os.path.exists(csv_path):
        print(f"❌ CSV not found: {csv_path}")
        print(f"   Create it at: data/metafield_definitions.csv")
        sys.exit(1)
    main(csv_path)
