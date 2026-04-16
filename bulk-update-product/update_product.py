import sys
import csv
import json
import os
import time
import argparse

import pandas as pd
import requests

from utils import make_headers, get_product_gids_by_skus, get_variant_gids_by_skus, get_val, gql, read_csv_auto, API_URL

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HEADERS     = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
LOCATION_ID = os.getenv("SHOPIFY_LOCATION_ID", "")

# ── Column mapping (CSV header → Shopify field) ───────────────
COL = {
    "sku":              "Variant SKU",
    "title":            "Title",
    "body_html":        "Body (HTML)",
    "vendor":           "Vendor",
    "product_type":     "Product Type",
    "power_type":       "Power Type",
    "tags":             "Tags",
    "status":           "Status",
    "price":            "Price",
    "compare_at_price": "Compare At Price",
    "inventory_qty":    "Inventory quantity",
}


# ── Product update (Bulk API) ─────────────────────────────────

def build_jsonl(csv_file: str, jsonl_file: str) -> tuple[int, dict, list]:
    df = read_csv_auto(csv_file)
    print(f"Columns found: {df.columns.tolist()}")

    sku_col = COL["sku"] if COL["sku"] in df.columns else "sku"
    if sku_col not in df.columns:
        print(f"Cannot find SKU column. Available: {df.columns.tolist()}")
        return 0, {}

    skus = df[sku_col].dropna().tolist()
    print(f"{len(skus)} SKUs found")

    gid_map         = get_product_gids_by_skus(API_URL, HEADERS, skus)
    variant_gid_map = get_variant_gids_by_skus(API_URL, HEADERS, skus)
    not_found = [s for s, g in gid_map.items() if g is None]
    if not_found:
        print(f"Not found: {not_found}")
        pd.DataFrame({"sku": not_found}).to_csv(os.path.join(os.path.dirname(__file__), "output", "not_found.csv"), index=False)

    sku_qty_map: dict[str, str] = {}
    price_entries: list = []
    count = 0

    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            sku = row[sku_col]
            gid = gid_map.get(sku)
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
                input_data.setdefault("metafields", []).append({
                    "namespace": "custom",
                    "key":       "part_type",
                    "value":     v,
                    "type":      "single_line_text_field",
                })
            if v := get_val(row, COL["tags"]):
                input_data["tags"] = [t.strip() for t in v.split(",")]
            if v := get_val(row, COL["status"]):
                input_data["status"] = v.upper()

            if v := get_val(row, COL["inventory_qty"]):
                sku_qty_map[sku] = v

            price         = get_val(row, COL["price"])
            compare_price = get_val(row, COL["compare_at_price"])
            if price or compare_price:
                # API 2024-07+: price must be updated via productVariantsBulkUpdate, NOT productUpdate
                variant_gid = variant_gid_map.get(sku)
                if variant_gid:
                    price_entries.append({
                        "productId":    gid,
                        "variantId":    variant_gid,
                        "price":        price,
                        "compareAtPrice": compare_price,
                    })

            if len(input_data) <= 1:
                continue

            f.write(json.dumps({"input": input_data}) + "\n")
            count += 1

    print(f"{count} product rows -> {jsonl_file} | {len(price_entries)} price entries collected")
    return count, sku_qty_map, price_entries


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
            productVariants { id price compareAtPrice }
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


# ── Inventory update (batch) ──────────────────────────────────

def read_inventory_csv(filepath: str) -> list[dict]:
    rows = []
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            rows.append({"sku": row["sku"].strip(), "quantity": int(row["quantity"].strip())})
    print(f"Loaded {len(rows)} rows from {filepath}")
    return rows


INVENTORY_CACHE_FILE = os.path.join(os.path.dirname(__file__), "cache", "inventory_item_ids.json")


def get_inventory_item_ids_batch(skus: list, batch_size: int = 50) -> dict:
    """Resolve SKUs -> inventoryItemId using alias batching.
    Loads from cache file if available; saves to cache after fetching from API.
    Returns {sku: inventoryItemId or None}
    """
    # Load cache
    cache: dict = {}
    if os.path.exists(INVENTORY_CACHE_FILE):
        with open(INVENTORY_CACHE_FILE, encoding="utf-8") as f:
            cache = json.load(f)

    missing = [sku for sku in skus if sku not in cache]
    if not missing:
        print(f"  All {len(skus)} SKUs loaded from cache ({INVENTORY_CACHE_FILE})")
        return {sku: cache.get(sku) for sku in skus}

    if len(missing) < len(skus):
        print(f"  Cache hit: {len(skus) - len(missing)} SKUs | Fetching: {len(missing)} SKUs")
    else:
        print(f"  No cache found — fetching {len(missing)} SKUs from API...")

    total = len(missing)
    for i in range(0, total, batch_size):
        batch = missing[i:i + batch_size]
        aliases = "\n".join([
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") '
            f'{{ edges {{ node {{ sku inventoryItem {{ id }} }} }} }}'
            for j, sku in enumerate(batch)
        ])
        body = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            cache[sku] = edges[0]["node"]["inventoryItem"]["id"] if edges else None
        print(f"  Resolved: {min(i + batch_size, total)}/{total}")
        time.sleep(0.5)

    # Save updated cache
    with open(INVENTORY_CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    print(f"  Cache saved: {INVENTORY_CACHE_FILE}")

    return {sku: cache.get(sku) for sku in skus}


def build_inventory_jsonl(quantities: list, jsonl_file: str, batch_size: int = 250) -> int:
    """Write JSONL for bulk inventory update.
    Each line = one inventorySetQuantities call with up to batch_size items.
    Returns number of lines written.
    """
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


def update_inventory(rows: list[dict]):
    """Resolve SKU -> inventoryItemId, build JSONL, then run async bulk mutation."""
    skus = [r["sku"] for r in rows]
    qty_map = {r["sku"]: r["quantity"] for r in rows}

    print(f"Resolving inventoryItemId for {len(skus)} SKUs...")
    inv_map = get_inventory_item_ids_batch(skus)

    not_found = [sku for sku, iid in inv_map.items() if iid is None]
    if not_found:
        print(f"  Warning: {len(not_found)} SKU(s) not found: {not_found[:10]}")

    # Deduplicate by inventoryItemId — keep last quantity if same item appears multiple times
    seen: dict = {}  # inventoryItemId -> quantity
    for sku, iid in inv_map.items():
        if iid is None:
            continue
        seen[iid] = qty_map[sku]  # last SKU wins if duplicate inventoryItemId

    dup_count = len([iid for sku, iid in inv_map.items() if iid is not None]) - len(seen)
    if dup_count:
        print(f"  Warning: {dup_count} duplicate inventoryItemId(s) removed (same variant, multiple SKUs)")

    quantities = [
        {"inventoryItemId": iid, "locationId": LOCATION_ID, "quantity": qty}
        for iid, qty in seen.items()
    ]

    if not quantities:
        print("No inventory items to update.")
        return

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
    if not_found:
        print(f"SKU not found ({len(not_found)}): {not_found[:10]}")


def update_inventory_from_csv(filepath: str):
    update_inventory(read_inventory_csv(filepath))


def update_inventory_from_map(sku_qty_map: dict):
    rows = [{"sku": sku, "quantity": int(float(qty))} for sku, qty in sku_qty_map.items()]
    update_inventory(rows)


# ── Main ─────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Shopify product & inventory updater")
    parser.add_argument("--csv",           default="data/update_qty.csv", help="Main product CSV")
    parser.add_argument("--inv-csv",       default="",                    help="Inventory-only CSV (columns: sku, quantity)")
    parser.add_argument("--inv-only",      action="store_true",           help="Skip product update, run inventory only")
    parser.add_argument("--rebuild-cache", action="store_true",           help="Delete inventory cache and re-fetch from API")
    args = parser.parse_args()

    base_dir   = os.path.dirname(__file__)

    if args.rebuild_cache and os.path.exists(INVENTORY_CACHE_FILE):
        os.remove(INVENTORY_CACHE_FILE)
        print(f"Cache deleted: {INVENTORY_CACHE_FILE}")

    CSV_FILE   = os.path.join(base_dir, "data/update_price.csv")
    os.makedirs(os.path.join(base_dir, "output"), exist_ok=True)
    os.makedirs(os.path.join(base_dir, "cache"), exist_ok=True)
    JSONL_FILE = os.path.join(base_dir, "output", "bulk.jsonl")

    sku_qty_map: dict  = {}
    price_entries: list = []

    # ── 1. Product fields update ──
    if not args.inv_only:
        print(f"Using CSV: {CSV_FILE}")
        count, sku_qty_map, price_entries = build_jsonl(CSV_FILE, JSONL_FILE)

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

        # ── 1b. Price / compareAtPrice update (requires separate bulk op) ──
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
    inv_csv_path = (
        os.path.join(base_dir, args.inv_csv) if args.inv_csv else
        os.path.join(base_dir, "data/inventory.csv") if os.path.exists(os.path.join(base_dir, "data/inventory.csv")) else
        None
    )

    if inv_csv_path:
        print(f"\nInventory update from: {inv_csv_path}")
        update_inventory_from_csv(inv_csv_path)
    elif sku_qty_map:
        print(f"\nInventory update for {len(sku_qty_map)} SKUs from main CSV...")
        update_inventory_from_map(sku_qty_map)

    print("\nAll done!")
