import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import sys
import csv
import json
import os
import time
import argparse

import pandas as pd
import requests

from utils import make_headers, get_val, gql, read_csv_auto, API_URL

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HEADERS     = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
LOCATION_ID = os.getenv("SHOPIFY_LOCATION_ID", "")

# ── Column mapping (CSV header → Shopify field) ───────────────
COL = {
    "product_gid":      "Product GID",
    "variant_gid":      "Variant GID",
    "sku":              "Variant SKU",
    "title":            "Title",
    "body_html":        "Body (HTML)",
    "vendor":           "Vendor",
    "product_type":     "Type",
    "power_type":       "Power Type",
    "tags":             "Tags",
    "status":           "Status",
    "price":              "Price",
    "compare_at_price":   "Compare At Price",
    "new_sku":            "New SKU",
    "inventory_qty":      "Inventory quantity",
    "inventory_item_id":  "Inventory Item ID",
}

# ── Thai translation ──────────────────────────────────────────
LOCALE   = "th"
COL_THAI = {
    "title":            "Title TH",
    "body_html":        "Body (HTML) TH",
    "meta_title":       "meta_title",
    "meta_description": "meta_description",
}


# ── Product update (Bulk API) ─────────────────────────────────

def build_jsonl(csv_file: str, jsonl_file: str) -> tuple[int, list, list]:
    """Read GIDs directly from CSV — no API lookups.
    Returns (count, inv_entries, price_entries)
      inv_entries   = [{inventoryItemId, locationId, quantity}]
      price_entries = [{productId, variantId, price, compareAtPrice}]
    """
    df = read_csv_auto(csv_file)
    print(f"Columns found: {df.columns.tolist()}")

    gid_col     = COL["product_gid"]      # "Product GID"
    var_gid_col = COL["variant_gid"]      # "Variant GID"
    inv_id_col  = COL["inventory_item_id"] # "Inventory Item ID"

    if gid_col not in df.columns:
        print(f"[ERR] Column '{gid_col}' not found. Available: {df.columns.tolist()}")
        return 0, [], []

    inv_entries:   list = []
    price_entries: list = []
    count = 0

    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            gid = get_val(row, gid_col)
            if not gid:
                continue

            input_data: dict = {"id": gid}

            if v := get_val(row, COL["title"]):
                input_data["title"] = v
            if v := get_val(row, COL["body_html"]):
                input_data["descriptionHtml"] = v
            if v := get_val(row, COL["vendor"]):
                input_data["vendor"] = v
            if v := get_val(row, COL["product_type"]):
                input_data["productType"] = v
            if v := get_val(row, COL["tags"]):
                input_data["tags"] = [t.strip() for t in v.split(",")]
            if v := get_val(row, COL["status"]):
                input_data["status"] = v.upper()

            # ── Inventory (direct Inventory Item ID) ──
            inv_id = get_val(row, inv_id_col) if inv_id_col in df.columns else None
            qty    = get_val(row, COL["inventory_qty"])
            if inv_id and qty:
                inv_entries.append({
                    "inventoryItemId": inv_id,
                    "locationId":      LOCATION_ID,
                    "quantity":        int(float(qty)),
                })

            # ── Price / SKU (direct Variant GID) ──
            price         = get_val(row, COL["price"])
            compare_price = get_val(row, COL["compare_at_price"])
            new_sku       = get_val(row, COL["new_sku"]) if "new_sku" in COL and COL["new_sku"] in df.columns else None

            if price or compare_price or new_sku:
                variant_gid = get_val(row, var_gid_col) if var_gid_col in df.columns else None
                if variant_gid:
                    entry = {
                        "productId":      gid,
                        "variantId":      variant_gid,
                        "price":          price,
                        "compareAtPrice": compare_price,
                    }
                    if new_sku:
                        entry["sku"] = new_sku
                    price_entries.append(entry)

            if len(input_data) <= 1:
                continue

            f.write(json.dumps({"input": input_data}) + "\n")
            count += 1

    print(f"{count} product rows -> {jsonl_file} | {len(inv_entries)} inv | {len(price_entries)} price")
    return count, inv_entries, price_entries


def create_staged_upload(filename: str = "bulk.jsonl") -> dict | None:
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
    print(f"Staged upload created: {target['resourceUrl']}")
    return target


def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"Uploaded: {filepath} (HTTP {res.status_code})")
    return target["resourceUrl"]


def build_price_jsonl(price_entries: list, jsonl_file: str) -> int:
    """Build JSONL for productVariantsBulkUpdate (Shopify API 2024-07+)."""
    count = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for entry in price_entries:
            variant_input: dict = {"id": entry["variantId"]}
            if entry.get("price") is not None:
                variant_input["price"] = entry["price"]
            if entry.get("compareAtPrice") is not None:
                variant_input["compareAtPrice"] = entry["compareAtPrice"]
            if entry.get("sku") is not None:
                variant_input["inventoryItem"] = {"sku": entry["sku"]}
            f.write(json.dumps({"productId": entry["productId"], "variants": [variant_input]}) + "\n")
            count += 1
    print(f"{count} price rows -> {jsonl_file}")
    return count


def run_price_bulk_mutation(resource_url: str) -> dict | None:
    mutation = """
    mutation bulkPriceUpdate($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation variantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price compareAtPrice sku }
            userErrors { field message }
          }
        }",
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
        print(f"Price bulk mutation error: {op['userErrors']}")
        return None
    print(f"Price bulk operation started: {op['bulkOperation']['id']}")
    return op


def run_bulk_mutation(resource_url: str) -> dict | None:
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
    body = gql(API_URL, HEADERS, mutation, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"Bulk mutation error: {op['userErrors']}")
        return None
    print(f"Bulk operation started: {op['bulkOperation']['id']}")
    return op


def poll_status(interval: int = 15) -> str | None:
    query = """{ currentBulkOperation(type: MUTATION) {
        id status errorCode objectCount url } }"""
    while True:
        body = gql(API_URL, HEADERS, query)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print("No active bulk operation found.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"Bulk operation failed: {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Thai translation functions ────────────────────────────────

def get_digests_batch(product_gids: list, batch_size: int = 100) -> dict:
    """Fetch translatableContent digests for many products in batched alias queries."""
    all_digests: dict = {}
    total = len(product_gids)
    for i in range(0, total, batch_size):
        batch = product_gids[i:i + batch_size]
        aliases = "\n".join([
            f'r{j}: translatableResource(resourceId: "{gid}") '
            f'{{ translatableContent {{ key digest }} }}'
            for j, gid in enumerate(batch)
        ])
        result = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        if result is None or result.get("errors"):
            print(f"  [ERR] Digest batch error: {(result or {}).get('errors')}")
            for gid in batch:
                all_digests[gid] = {}
            continue
        data = result.get("data", {})
        for j, gid in enumerate(batch):
            resource = data.get(f"r{j}")
            all_digests[gid] = (
                {item["key"]: item["digest"] for item in resource["translatableContent"]}
                if resource else {}
            )
        print(f"  Fetched digests {min(i + batch_size, total)}/{total}")
        time.sleep(0.3)
    return all_digests


def build_translation_jsonl(csv_file: str, jsonl_file: str, locale: str = LOCALE) -> int:
    """Build JSONL for Thai (or any locale) translations using translationsRegister."""
    df = read_csv_auto(csv_file)
    print(f"Columns found: {df.columns.tolist()}")

    gid_col = COL["product_gid"]  # "Product GID"
    sku_col = COL["sku"] if COL["sku"] in df.columns else "sku"

    has_gid_col = gid_col in df.columns
    has_sku_col = sku_col in df.columns

    if not has_gid_col and not has_sku_col:
        print(f"[ERR] Cannot find 'Product GID' or SKU column. Available: {df.columns.tolist()}")
        return 0

    gid_map: dict = {}
    if has_sku_col and not has_gid_col:
        skus = df[sku_col].dropna().unique().tolist()
        print(f"{len(skus)} unique SKUs found")
        gid_map   = get_product_gids_by_skus(API_URL, HEADERS, skus)
        not_found = [s for s, g in gid_map.items() if g is None]
        if not_found:
            print(f"  Warning: not found: {not_found}")

    # Collect all GIDs to fetch digests
    all_gids: list = []
    for _, row in df.iterrows():
        gid = get_val(row, gid_col) if has_gid_col else gid_map.get(get_val(row, sku_col))
        if gid:
            all_gids.append(gid)
    valid_gids = list(dict.fromkeys(all_gids))  # deduplicate, preserve order
    print(f"Fetching digests for {len(valid_gids)} products...")
    digest_map = get_digests_batch(valid_gids)

    rows_written = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            if has_gid_col:
                product_gid = get_val(row, gid_col)
            else:
                product_gid = gid_map.get(get_val(row, sku_col))
            if not product_gid:
                continue
            digests = digest_map.get(product_gid, {})
            if not digests:
                print(f"  Warning: no digests for SKU {sku}")
                continue
            for field, csv_col in COL_THAI.items():
                if csv_col not in df.columns or field not in digests:
                    continue
                raw = row.get(csv_col)
                if pd.isna(raw):
                    continue
                value = str(raw).strip()
                if not value:
                    continue
                f.write(json.dumps({
                    "resourceId": product_gid,
                    "input": {
                        "key":                        field,
                        "value":                      value,
                        "locale":                     locale,
                        "translatableContentDigest":  digests[field],
                    },
                }, ensure_ascii=False) + "\n")
                rows_written += 1

    print(f"{rows_written} translation entries -> {jsonl_file}")
    return rows_written


def create_staged_upload_translation(filename: str = "translation_bulk.jsonl") -> dict | None:
    """Staged upload using POST (multipart) — required for translation bulk ops."""
    query = f"""
    mutation {{
      stagedUploadsCreate(input: {{
        resource: BULK_MUTATION_VARIABLES,
        filename: "{filename}",
        mimeType: "text/jsonl",
        httpMethod: POST
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
    print(f"Staged upload (POST) created: {target['resourceUrl']}")
    return target


def upload_jsonl_post(target: dict, filepath: str) -> str:
    """Upload JSONL via multipart POST (for translation bulk ops)."""
    params = {p["name"]: p["value"] for p in target["parameters"]}
    with open(filepath, "rb") as f:
        res = requests.post(target["url"], data=params, files={"file": f})
    res.raise_for_status()
    staged_path = params.get("key", target["resourceUrl"])
    print(f"Uploaded (POST): {filepath}")
    return staged_path


def run_translation_bulk_mutation(resource_url: str) -> dict | None:
    mutation = """
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
    }"""
    body = gql(API_URL, HEADERS, mutation, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"Translation bulk mutation error: {op['userErrors']}")
        return None
    print(f"Translation bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Inventory update ─────────────────────────────────────────

def read_inventory_csv(filepath: str) -> list[dict]:
    """Read inventory CSV with columns: Inventory Item ID, Inventory quantity."""
    rows = []
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            inv_id = (row.get(COL["inventory_item_id"]) or row.get("Inventory Item ID") or "").strip()
            qty    = (row.get(COL["inventory_qty"])     or row.get("Inventory quantity") or "").strip()
            if inv_id and qty:
                rows.append({
                    "inventoryItemId": inv_id,
                    "locationId":      LOCATION_ID,
                    "quantity":        int(float(qty)),
                })
    print(f"Loaded {len(rows)} inventory rows from {filepath}")
    return rows


def build_inventory_jsonl(quantities: list, jsonl_file: str, batch_size: int = 250) -> int:
    """Write JSONL for bulk inventory update.
    Each line = one inventorySetQuantities call with up to batch_size items.
    Returns number of lines written.
    """
    # Shopify inventorySetQuantities supports at most 250 quantities per call.
    if batch_size > 250:
        batch_size = 250

    count = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for i in range(0, len(quantities), batch_size):
            batch = quantities[i:i + batch_size]
            payload = {
                "input": {
                    "name":                  "available",
                    "reason":                "correction",
                    "ignoreCompareQuantity": True,
                    "quantities":            batch,
                }
            }
            f.write(json.dumps(payload) + "\n")
            count += 1
    print(f"  {len(quantities)} items -> {count} batches -> {jsonl_file}")
    return count


def run_inventory_bulk_mutation(resource_url: str) -> dict | None:
    mutation = """
    mutation bulkInvUpdate($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation invSet($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup { id }
            userErrors { field message }
          }
        }",
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
        print(f"Inventory bulk mutation error: {op['userErrors']}")
        return None
    print(f"Inventory bulk operation started: {op['bulkOperation']['id']}")
    return op


def run_inventory(quantities: list[dict]):
    """Build JSONL from pre-resolved quantities and run bulk mutation.
    quantities = [{inventoryItemId, locationId, quantity}, ...]
    """
    if not quantities:
        print("No inventory items to update.")
        return
    # Deduplicate — keep last entry if same inventoryItemId appears twice
    seen: dict = {q["inventoryItemId"]: q for q in quantities}
    quantities = list(seen.values())
    print(f"Building inventory JSONL for {len(quantities)} items...")
    jsonl_file = os.path.join(os.path.dirname(__file__), "output", "inventory_bulk.jsonl")
    build_inventory_jsonl(quantities, jsonl_file)
    target = create_staged_upload("inventory_bulk.jsonl")
    if not target:
        print("  Failed to create staged upload for inventory.")
        return
    resource_url = upload_jsonl(target, jsonl_file)
    op = run_inventory_bulk_mutation(resource_url)
    if not op:
        print("  Inventory bulk mutation did not start.")
        return
    print("Polling inventory bulk operation...")
    result_url = poll_status()
    print(f"\n{'='*40}")
    print(f"Inventory bulk done. Result URL: {result_url}")


# ── Main ─────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Shopify product & inventory updater")
    parser.add_argument("--csv",      default="data/sample_update_data.csv", help="Main CSV (must contain Product GID column)")
    parser.add_argument("--inv-csv",  default="",                    help="Inventory-only CSV (columns: Inventory Item ID, Inventory quantity)")
    parser.add_argument("--inv-only", action="store_true",           help="Skip product update, run inventory only")
    parser.add_argument("--thai",     action="store_true",           help="Run Thai translation update (auto-detected if Thai columns exist)")
    parser.add_argument("--no-thai",  action="store_true",           help="Skip Thai translation even if Thai columns exist")
    parser.add_argument("--thai-csv", default="",                    help="Thai CSV (default: same as --csv)")
    args = parser.parse_args()

    base_dir   = os.path.dirname(__file__)
    
    # Resolve CSV path
    if os.path.exists(args.csv):
        CSV_FILE = args.csv
    else:
        CSV_FILE = os.path.join(os.path.dirname(base_dir), args.csv)
        
    JSONL_FILE = os.path.join(base_dir, "output", "bulk.jsonl")
    os.makedirs(os.path.join(base_dir, "output"), exist_ok=True)

    inv_entries:   list = []
    price_entries: list = []

    # ── 1. Product fields update ──
    if not args.inv_only:
        print(f"Using CSV: {CSV_FILE}")
        count, inv_entries, price_entries = build_jsonl(CSV_FILE, JSONL_FILE)

        if count > 0:
            target = create_staged_upload()
            if not target:
                exit(1)
            resource_url = upload_jsonl(target, JSONL_FILE)
            op = run_bulk_mutation(resource_url)
            if not op:
                print("Bulk mutation did not start.")
                exit(1)
            result_url = poll_status()
            print(f"Bulk done. Result URL: {result_url}")
        else:
            print("No product fields to update — skipping bulk upload.")

        # ── 1b. Price / compareAtPrice update ──
        if price_entries:
            print(f"\nPrice update for {len(price_entries)} variant(s)...")
            price_jsonl = os.path.join(base_dir, "output", "price_bulk.jsonl")
            build_price_jsonl(price_entries, price_jsonl)
            target = create_staged_upload("price_bulk.jsonl")
            if not target:
                print("  Failed to create staged upload for prices.")
            else:
                resource_url = upload_jsonl(target, price_jsonl)
                op = run_price_bulk_mutation(resource_url)
                if op:
                    result_url = poll_status()
                    print(f"Price bulk done. Result URL: {result_url}")
                else:
                    print("  Price bulk mutation did not start.")

    # ── 2. Inventory update ──
    if args.inv_csv:
        inv_csv_path = os.path.join(base_dir, args.inv_csv)
        print(f"\nInventory update from: {inv_csv_path}")
        run_inventory(read_inventory_csv(inv_csv_path))
    elif inv_entries:
        print(f"\nInventory update for {len(inv_entries)} item(s) from main CSV...")
        run_inventory(inv_entries)

    # ── 3. Thai translation (digest fetch required by Shopify) ──
    # Auto-detect Thai columns if --thai not passed
    if not args.thai and not args.no_thai:
        try:
            _df_check = read_csv_auto(CSV_FILE)
            _thai_cols = [COL_THAI[k] for k in COL_THAI]
            args.thai = any(c in _df_check.columns for c in _thai_cols)
            if args.thai:
                print("\nThai columns detected — running translation automatically.")
        except Exception:
            pass
    if args.thai and not args.no_thai:
        _thai_csv_rel = args.thai_csv if args.thai_csv else args.csv
        thai_csv      = os.path.join(base_dir, _thai_csv_rel)
        thai_jsonl    = os.path.join(base_dir, "output", "translation_bulk.jsonl")
        print(f"\nThai translation from: {thai_csv}")
        count_thai = build_translation_jsonl(thai_csv, thai_jsonl)
        if count_thai > 0:
            target = create_staged_upload_translation()
            if target:
                resource_url = upload_jsonl_post(target, thai_jsonl)
                op = run_translation_bulk_mutation(resource_url)
                if op:
                    result_url = poll_status()
                    print(f"Translation bulk done. Result URL: {result_url}")
                else:
                    print("  Translation bulk mutation did not start.")
        else:
            print("No translation entries to process.")

    print("\nAll done!")
