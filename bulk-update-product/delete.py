import pandas as pd
import time
import os
from utils import make_headers, gql, read_csv_auto, API_URL

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
    body   = gql(API_URL, HEADERS, mutation, {"input": {"id": product_gid}})
    if not body:
        return False
    result = body.get("data", {}).get("productDelete", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Error: {result['userErrors']}")
        return False
    print(f"  🗑️ Deleted: {result.get('deletedProductId')}")
    return True


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    base_dir = os.path.dirname(__file__)
    CSV_FILE = os.path.join(base_dir, "data", "delete21469.csv")  # ต้องมี column "ProductGID"

    df = read_csv_auto(CSV_FILE)
    print(f"Columns found: {df.columns.tolist()}")

    gid_col = "ProductGID"
    if gid_col not in df.columns:
        print(f"❌ Cannot find ProductGID column. Available: {df.columns.tolist()}")
        exit(1)

    gids = df[gid_col].dropna().tolist()
    print(f"📋 {len(gids)} products to delete")

    # ── Safety check ──────────────────────────────────────────
    confirm = input(f"\n⚠️  Are you sure you want to DELETE {len(gids)} products? (yes/no): ")
    if confirm.lower() != "yes":
        print("❌ Cancelled.")
        exit(0)

    success = 0
    failed  = 0
    not_found = []

    for gid in gids:
        print(f"\n🔄 Deleting: {gid}")
        ok = delete_product(gid)
        if ok:
            success += 1
        else:
            failed += 1
            not_found.append(gid)

        time.sleep(0.5)  # rate limit

    if not_found:
        pd.DataFrame({"ProductGID": not_found}).to_csv(os.path.join(base_dir, "output", "not_found.csv"), index=False)
        print(f"\n⚠️ {len(not_found)} products failed → saved to output/not_found.csv")

    print(f"\n🎉 Done! Deleted: {success} | Failed: {failed}")
