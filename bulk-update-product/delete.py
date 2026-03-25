import requests
import pandas as pd
import time
import os
from dotenv import load_dotenv

load_dotenv()

SHOP  = os.getenv("SHOP_NAME")
TOKEN = os.getenv("SHOPIFY_ACCESS_TOKEN_IMPORT_PRODUCT")
print(f"SHOP: {SHOP}")
print(f"TOKEN: {TOKEN[:10]}..." if TOKEN else "TOKEN: None")

HEADERS = {"Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN}
API_URL = f"https://{SHOP}/admin/api/2025-01/graphql.json"


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


# ── Delete product by GID ─────────────────────────────────────
def delete_product(product_gid):
    mutation = """
    mutation deleteProduct($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }"""
    res    = requests.post(API_URL, json={
        "query": mutation,
        "variables": {"input": {"id": product_gid}}
    }, headers=HEADERS)
    result = res.json().get("data", {}).get("productDelete", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Error: {result['userErrors']}")
        return False
    print(f"  🗑️ Deleted: {result.get('deletedProductId')}")
    return True


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    base_dir = os.path.dirname(__file__)
    CSV_FILE = os.path.join(base_dir, "test_delete.csv")  # ต้องมี column "Variant SKU"

    df = pd.read_csv(CSV_FILE)
    print(f"Columns found: {df.columns.tolist()}")

    sku_col = "Variant SKU" if "Variant SKU" in df.columns else "sku"
    if sku_col not in df.columns:
        print(f"❌ Cannot find SKU column. Available: {df.columns.tolist()}")
        exit(1)

    skus = df[sku_col].dropna().tolist()
    print(f"📋 {len(skus)} SKUs to delete")

    # ── Safety check ──────────────────────────────────────────
    confirm = input(f"\n⚠️  Are you sure you want to DELETE {len(skus)} products? (yes/no): ")
    if confirm.lower() != "yes":
        print("❌ Cancelled.")
        exit(0)

    gid_map = get_product_gids_by_skus(skus)

    success = 0
    failed  = 0
    not_found = []

    for sku in skus:
        gid = gid_map.get(sku)
        if not gid:
            print(f"⚠️ SKU not found: {sku}")
            not_found.append(sku)
            failed += 1
            continue

        print(f"\n🔄 Deleting SKU: {sku} → {gid}")
        ok = delete_product(gid)
        if ok:
            success += 1
        else:
            failed += 1

        time.sleep(0.5)  # rate limit

    if not_found:
        pd.DataFrame({"sku": not_found}).to_csv("not_found.csv", index=False)
        print(f"\n⚠️ {len(not_found)} SKUs not found → saved to not_found.csv")

    print(f"\n🎉 Done! Deleted: {success} | Failed: {failed}")
