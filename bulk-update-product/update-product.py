import sys
import pandas as pd
import json
import time
import os
import requests
from utils import make_headers, get_product_gids_by_skus, gql, API_URL

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

    gid_map   = get_product_gids_by_skus(API_URL, HEADERS, skus)
    not_found = [s for s, g in gid_map.items() if g is None]
    if not_found:
        print(f"⚠️ Not found: {not_found}")
        pd.DataFrame({"sku": not_found}).to_csv("not_found.csv", index=False)

    sku_qty_map = {}
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

            # ── Inventory qty (collected separately, updated via inventorySetOnHandQuantities) ──
            inventory_qty = get_val(row, COL["inventory_qty"])
            if inventory_qty:
                sku_qty_map[sku] = inventory_qty

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
    return count, sku_qty_map


# ── Inventory Update ─────────────────────────────────────────
import csv as _csv


def read_inventory_csv(filepath: str) -> list:
    rows = []
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = _csv.DictReader(f)
        for row in reader:
            sku = row["sku"].strip()
            qty = int(row["quantity"].strip())
            rows.append({"sku": sku, "quantity": qty})
    print(f"Loaded {len(rows)} rows from {filepath}")
    return rows


def get_inventory_item_by_sku(sku: str):
    """Return (inventoryItemId, locationId, current_qty) for a SKU."""
    query = """
    query getInventoryBySku($query: String!) {
      productVariants(first: 5, query: $query) {
        edges {
          node {
            sku
            inventoryItem {
              id
              inventoryLevels(first: 5) {
                edges {
                  node {
                    location { id }
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
      }
    }"""
    body = gql(API_URL, HEADERS, query, {"query": f"sku:{sku}"})
    if not body:
        return None, None, None

    edges = body["data"]["productVariants"]["edges"]
    for edge in edges:
        node = edge["node"]
        if node["sku"] == sku:
            inv_id = node["inventoryItem"]["id"]
            levels = node["inventoryItem"]["inventoryLevels"]["edges"]
            if not levels:
                return inv_id, None, None
            for lvl in levels:
                loc = lvl["node"]["location"]
                if not LOCATION_ID or loc["id"] == LOCATION_ID:
                    current_qty = lvl["node"]["quantities"][0]["quantity"]
                    return inv_id, loc["id"], current_qty
    return None, None, None


def set_inventory_quantity(inventory_item_id: str, location_id: str, new_quantity: int):
    mutation = """
    mutation setInventoryQuantity($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          changes { name delta quantityAfterChange }
        }
        userErrors { field message }
      }
    }"""
    variables = {
        "input": {
            "name": "available",
            "reason": "correction",
            "ignoreCompareQuantity": True,
            "quantities": [{
                "inventoryItemId": inventory_item_id,
                "locationId":      location_id,
                "quantity":        new_quantity,
            }],
        }
    }
    body = gql(API_URL, HEADERS, mutation, variables)
    if not body:
        return False, [{"message": "No response from API"}]
    errors = body["data"]["inventorySetQuantities"]["userErrors"]
    if errors:
        return False, errors
    changes = body["data"]["inventorySetQuantities"]["inventoryAdjustmentGroup"]["changes"]
    return True, changes


def update_inventory_from_csv(inventory_csv: str):
    """Read inventory.csv and set quantities via inventorySetQuantities."""
    rows = read_inventory_csv(inventory_csv)
    success_count = 0
    fail_count    = 0
    skipped       = []

    for row in rows:
        sku     = row["sku"]
        new_qty = row["quantity"]
        print(f"\nProcessing SKU: {sku} -> qty={new_qty}")

        inv_item_id, loc_id, current_qty = get_inventory_item_by_sku(sku)

        if not inv_item_id:
            print(f"  Warning: SKU not found: {sku}")
            skipped.append(sku)
            fail_count += 1
            time.sleep(0.5)
            continue

        if not loc_id:
            print(f"  Warning: No inventory location for SKU: {sku}")
            skipped.append(sku)
            fail_count += 1
            time.sleep(0.5)
            continue

        ok, result = set_inventory_quantity(inv_item_id, loc_id, new_qty)
        if ok:
            for c in result:
                print(f"  OK '{c['name']}': {current_qty} -> {c['quantityAfterChange']} (delta {c['delta']})")
            success_count += 1
        else:
            print(f"  Error: {result}")
            fail_count += 1

        time.sleep(0.5)

    print(f"\n{'='*40}")
    print(f"Success : {success_count}")
    print(f"Failed  : {fail_count}")
    if skipped:
        print(f"Skipped : {', '.join(skipped)}")


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
    import argparse

    parser = argparse.ArgumentParser(description="Shopify product & inventory updater")
    parser.add_argument("--csv",       default="data/update_qty.csv", help="Main product CSV")
    parser.add_argument("--inv-csv",   default="",                    help="Inventory-only CSV (sku, quantity columns)")
    parser.add_argument("--inv-only",  action="store_true",           help="Skip product update, run inventory only")
    args = parser.parse_args()

    base_dir   = os.path.dirname(__file__)
    CSV_FILE   = os.path.join(base_dir, args.csv)
    JSONL_FILE = os.path.join(base_dir, "bulk.jsonl")

    # ── Product update ──
    if not args.inv_only:
        print(f"Using CSV: {CSV_FILE}")
        count, sku_qty_map = build_jsonl(CSV_FILE, JSONL_FILE)

        if count > 0:
            target = create_staged_upload()
            if not target:
                exit(1)

            resource_url = upload_jsonl(target, JSONL_FILE)

            op = run_bulk_mutation(resource_url)
            if not op:
                print("Bulk mutation did not start. Exiting.")
                exit(1)

            result_url = poll_status()
            print(f"Done! Result: {result_url}")
        else:
            print("No product fields to update — skipping bulk upload.")
    else:
        sku_qty_map = {}

    # ── Inventory update ──
    # Priority: --inv-csv flag > inventory.csv next to script > qty from main CSV
    inv_csv_path = (
        os.path.join(base_dir, args.inv_csv) if args.inv_csv else
        os.path.join(base_dir, "data/inventory.csv") if os.path.exists(os.path.join(base_dir, "data/inventory.csv")) else
        None
    )

    if inv_csv_path:
        print(f"\nRunning inventory update from: {inv_csv_path}")
        update_inventory_from_csv(inv_csv_path)
    elif sku_qty_map:
        print(f"\nUpdating inventory for {len(sku_qty_map)} SKUs from main CSV...")
        # build a temp list and reuse update_inventory_from_csv logic inline
        import io as _io
        tmp = _io.StringIO("sku,quantity\n" + "\n".join(f"{s},{q}" for s, q in sku_qty_map.items()))
        rows = list(_csv.DictReader(tmp))
        rows = [{"sku": r["sku"], "quantity": int(r["quantity"])} for r in rows]
        success, fail, skipped = 0, 0, []
        for row in rows:
            inv_id, loc_id, cur = get_inventory_item_by_sku(row["sku"])
            if not inv_id or not loc_id:
                print(f"  Warning: SKU not found or no location: {row['sku']}")
                skipped.append(row["sku"]); fail += 1; time.sleep(0.5); continue
            ok, result = set_inventory_quantity(inv_id, loc_id, row["quantity"])
            if ok:
                for c in result:
                    print(f"  OK {row['sku']} '{c['name']}': {cur} -> {c['quantityAfterChange']}")
                success += 1
            else:
                print(f"  Error {row['sku']}: {result}"); fail += 1
            time.sleep(0.5)
        print(f"\nInventory — Success: {success}, Failed: {fail}")

    print("\nAll done!")
