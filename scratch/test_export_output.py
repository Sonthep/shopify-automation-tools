import sys
import json
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_export():
    client = ShopifyClient()
    query = """
    {
      products(first: 2) {
        edges {
          node {
            id
            handle
            title
            descriptionHtml
            vendor
            productType
            tags
            status
            publishedAt
            variants(first: 2) {
              edges {
                node {
                  id
                  sku
                  price
                  compareAtPrice
                  inventoryQuantity
                  inventoryItem { id }
                }
              }
            }
            images(first: 1) {
              edges { node { url } }
            }
            metafields(first: 10) {
              edges {
                node { namespace key value }
              }
            }
          }
        }
      }
    }
    """
    
    print("🔄 Running test query against Shopify API...")
    res = client.gql(query)
    if not res or "data" not in res:
        print("❌ Query failed or empty response")
        return

    headers = [
        "custom.good_id", "Variant SKU", "Product GID", "Variant GID",
        "Inventory Item ID", "Handle", "Title", "Body (HTML)", "Vendor",
        "Type", "Tags", "Status", "Published", "Price", "Compare At Price",
        "Inventory", "Image Src", "custom.spapart_or_product"
    ]

    products_edges = res["data"]["products"]["edges"]
    rows = []

    for p_edge in products_edges:
        p = p_edge["node"]
        meta_dict = {}
        for m_edge in p.get("metafields", {}).get("edges", []):
            m = m_edge["node"]
            meta_dict[f"{m['namespace']}.{m['key']}"] = m["value"]

        variants_edges = p.get("variants", {}).get("edges", [])
        p_imgs = p.get("images", {}).get("edges", [])
        img_url = p_imgs[0]["node"]["url"] if p_imgs else ""

        for v_edge in variants_edges:
            v = v_edge["node"]
            inv_id = v.get("inventoryItem", {}).get("id", "") if v.get("inventoryItem") else ""

            row_obj = {
                "custom.good_id": meta_dict.get("custom.good_id", ""),
                "Variant SKU": v.get("sku", ""),
                "Product GID": p.get("id", ""),
                "Variant GID": v.get("id", ""),
                "Inventory Item ID": inv_id,
                "Handle": p.get("handle", ""),
                "Title": p.get("title", ""),
                "Body (HTML)": (p.get("descriptionHtml", "")[:30] + "...") if p.get("descriptionHtml") else "",
                "Vendor": p.get("vendor", ""),
                "Type": p.get("productType", ""),
                "Tags": ", ".join(p.get("tags", [])),
                "Status": p.get("status", ""),
                "Published": "TRUE" if p.get("publishedAt") else "FALSE",
                "Price": v.get("price", ""),
                "Compare At Price": v.get("compareAtPrice", ""),
                "Inventory": v.get("inventoryQuantity", ""),
                "Image Src": img_url[:40] + "..." if img_url else "",
                "custom.spapart_or_product": meta_dict.get("custom.spapart_or_product", "")
            }
            rows.append(row_obj)

    print(f"\n✅ Total {len(headers)} Columns in exact order:")
    print(" | ".join(headers))
    print("-" * 110)
    for i, r in enumerate(rows, 1):
        print(f"\n--- Row {i} ---")
        for h in headers:
            val = str(r.get(h, ""))
            if len(val) > 40:
                val = val[:37] + "..."
            print(f"  {h:<25}: {val}")

if __name__ == "__main__":
    test_export()
