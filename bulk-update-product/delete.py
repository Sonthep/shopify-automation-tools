import requests
import pandas as pd
import time
import os
from utils import make_headers, get_product_gids_by_skus, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")


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
    CSV_FILE = os.path.join(base_dir, "delete_31369.csv")  # ต้องมี column "Variant SKU"

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

    gid_map = get_product_gids_by_skus(API_URL, HEADERS, skus)

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
