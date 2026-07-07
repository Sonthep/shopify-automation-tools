"""
Update Shopify metafield definition access/visibility options from a CSV.

CSV format (data/update_metafield_definition_options.csv):
    key             - namespace.key เช่น custom.part_type หรือ specs.ampere
    admin           - READ_WRITE | READ | (empty = skip)
    storefront      - PUBLIC_READ | (empty = skip)
    customerAccount - READ_WRITE | READ | (empty = skip)
    visibleToStorefrontApi - true / false / (empty = skip)

Usage:
    py update_metafield_definition.py
    py update_metafield_definition.py data/my_definitions.csv
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import csv
import os
import sys
import time

from utils import make_headers, gql, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
base_dir = os.path.dirname(__file__)
DEFAULT_CSV = os.path.join(base_dir, "data", "update_metafield_definition_options.csv")

# ─────────────────────────────────────────
# Lookup definition ID by namespace + key
# ─────────────────────────────────────────
QUERY_DEF = """
query GetMetafieldDef($namespace: String!, $key: String!) {
  metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: $namespace, key: $key) {
    nodes { id name namespace key }
  }
}
"""


def get_definition_id(namespace: str, key: str) -> tuple[str | None, str | None]:
    """Returns (id, name) or (None, None) if not found."""
    body  = gql(API_URL, HEADERS, QUERY_DEF, {"namespace": namespace, "key": key})
    nodes = (body or {}).get("data", {}).get("metafieldDefinitions", {}).get("nodes", [])
    if not nodes:
        return None, None
    return nodes[0]["id"], nodes[0]["name"]


# ─────────────────────────────────────────
# GraphQL mutation
# ─────────────────────────────────────────
MUTATION_UPDATE = """
mutation UpdateMetafieldDefinition($definition: MetafieldDefinitionUpdateInput!) {
  metafieldDefinitionUpdate(definition: $definition) {
    updatedDefinition {
      id
      name
      access {
        admin
        storefront
        customerAccount
      }
    }
    userErrors {
      field
      message
    }
  }
}
"""


# ─────────────────────────────────────────
# Build definition input from a CSV row
# ─────────────────────────────────────────
# Shopify API uses MERCHANT_READ / MERCHANT_READ_WRITE for admin access
ADMIN_ENUM_MAP = {
    "READ_WRITE": "MERCHANT_READ_WRITE",
    "READ":       "MERCHANT_READ",
    "MERCHANT_READ_WRITE": "MERCHANT_READ_WRITE",
    "MERCHANT_READ":       "MERCHANT_READ",
}


def build_definition_input(row: dict, namespace: str, key: str) -> dict:
    definition: dict = {
        "key":       key,
        "ownerType": "PRODUCT",
    }
    if namespace:
        definition["namespace"] = namespace

    admin      = row.get("admin", "").strip().upper()
    storefront = row.get("storefront", "").strip()
    customer   = row.get("customerAccount", "").strip()

    access: dict = {}
    # Note: admin access cannot be changed for custom namespace via API
    # if admin and admin in ADMIN_ENUM_MAP:
    #     access["admin"] = ADMIN_ENUM_MAP[admin]
    if storefront:
        access["storefront"] = storefront
    if customer:
        access["customerAccount"] = customer
    if access:
        definition["access"] = access

    return definition


# ─────────────────────────────────────────
# Process one row
# ─────────────────────────────────────────
def process_row(row: dict) -> bool:
    raw_key = row.get("key", "").strip()
    if not raw_key:
        print("  ⚠️  Skipped — no key")
        return False

    if "." not in raw_key:
        print(f"  ⚠️  Skipped — key must be namespace.key format (got '{raw_key}')")
        return False

    namespace, key = raw_key.split(".", 1)

    definition = build_definition_input(row, namespace, key)

    result = gql(API_URL, HEADERS, MUTATION_UPDATE, {"definition": definition})
    data   = (result or {}).get("data", {}).get("metafieldDefinitionUpdate", {})
    errors = data.get("userErrors", [])

    if errors:
        for err in errors:
            print(f"  ❌ {raw_key}: {err.get('field')} — {err.get('message')}")
        return False

    updated = data.get("updatedDefinition")
    if updated:
        name   = updated.get("name", "")
        access = updated.get("access", {})
        print(
            f"  ✅ {name} ({raw_key})\n"
            f"     admin={access.get('admin')}  "
            f"storefront={access.get('storefront')}  "
            f"customerAccount={access.get('customerAccount')}"
        )
        return True

    print(f"  ⚠️  {raw_key}: unexpected empty response")
    return False


# ─────────────────────────────────────────
# Main
# ─────────────────────────────────────────
def main(csv_file: str) -> None:
    if not os.path.exists(csv_file):
        print(f"❌ CSV not found: {csv_file}")
        sys.exit(1)

    with open(csv_file, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    print(f"📋 {len(rows)} definition(s) to update from {os.path.basename(csv_file)}\n")

    ok = fail = skip = 0
    for i, row in enumerate(rows, 1):
        raw_key = row.get("key", "").strip()
        print(f"[{i}/{len(rows)}] {raw_key or '(no key)'}")
        result = process_row(row)
        if result is True:
            ok += 1
        elif result is False and raw_key:
            fail += 1
        else:
            skip += 1
        time.sleep(0.3)  # avoid rate-limit burst

    print(f"\n{'─'*50}")
    print(f"Done — ✅ {ok} updated  ❌ {fail} failed  ⚠️ {skip} skipped")


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    main(os.path.join(base_dir, csv_path) if not os.path.isabs(csv_path) else csv_path)
