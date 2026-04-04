import sys
import csv
import os
from utils import make_headers, gql, API_URL

# Fix Unicode output on Windows terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

base_dir = os.path.dirname(__file__)
OUTPUT_FILE = os.path.join(base_dir, "data", "missing_sku.csv")

QUERY = """
query getProductsWithEmptySKU($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        title
        status
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
            }
          }
        }
      }
    }
  }
}
"""

def fetch_products_with_empty_sku():
    results = []
    cursor = None
    total_products = 0
    total_variants = 0
    page = 0

    while True:
        body = gql(API_URL, HEADERS, QUERY, {"cursor": cursor})
        if body is None:
            print("❌ API request failed, stopping.")
            break

        products = body["data"]["products"]
        edges = products["edges"]
        page += 1
        total_products += len(edges)

        for product_edge in edges:
            product = product_edge["node"]
            for v_edge in product["variants"]["edges"]:
                variant = v_edge["node"]
                total_variants += 1
                sku = variant["sku"]
                if sku is None or str(sku).strip() == "":
                    results.append({
                        "product_id": product["id"],
                        "product_title": product["title"],
                        "product_status": product["status"],
                        "variant_id": variant["id"],
                        "variant_title": variant["title"],
                        "sku": sku,
                    })

        page_info = products["pageInfo"]
        print(f"  หน้า {page}: {len(edges)} products | รวม {total_products} products, {total_variants} variants | พบ empty SKU: {len(results)}")

        if page_info["hasNextPage"]:
            cursor = page_info["endCursor"]
        else:
            break

    print(f"\nสรุป: ตรวจสอบ {total_products} products, {total_variants} variants → พบ empty SKU {len(results)} รายการ")
    return results


def save_to_csv(data, filename=OUTPUT_FILE):
    if not data:
        print("ไม่พบข้อมูล variant ที่ไม่มี SKU")
        return

    os.makedirs(os.path.dirname(filename), exist_ok=True)
    fieldnames = ["product_id", "product_title", "product_status", "variant_id", "variant_title", "sku"]

    with open(filename, mode="w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(data)

    print(f"บันทึกไฟล์สำเร็จ: {filename} ({len(data)} แถว)")


if __name__ == "__main__":
    print("กำลังดึงข้อมูล...")
    data = fetch_products_with_empty_sku()
    save_to_csv(data)

