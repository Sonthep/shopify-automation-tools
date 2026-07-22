import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_product_variants_bulk_update():
    client = ShopifyClient()
    
    # 1. Fetch 1 product and its variant
    fetch_query = """
    {
      products(first: 1) {
        edges {
          node {
            id
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  compareAtPrice
                }
              }
            }
          }
        }
      }
    }
    """
    res = client.gql(fetch_query)
    if not res or "data" not in res:
        print("❌ Fetch failed")
        return
        
    p_node = res["data"]["products"]["edges"][0]["node"]
    product_gid = p_node["id"]
    variant_node = p_node["variants"]["edges"][0]["node"]
    variant_gid = variant_node["id"]
    curr_price = variant_node["price"]
    curr_compare = variant_node["compareAtPrice"]
    
    print(f"Fetched Product GID: {product_gid}")
    print(f"Fetched Variant GID: {variant_gid} (Price: {curr_price}, CompareAt: {curr_compare})")
    
    # 2. Test productVariantsBulkUpdate mutation
    mutation = f"""
    mutation {{
      v0: productVariantsBulkUpdate(productId: "{product_gid}", variants: [{{ id: "{variant_gid}", price: "{curr_price}" }}]) {{
        productVariants {{
          id
          price
          compareAtPrice
        }}
        userErrors {{
          field
          message
        }}
      }}
    }}
    """
    
    print("\n🔄 Sending test mutation productVariantsBulkUpdate...")
    m_res = client.gql(mutation)
    print("Response:", m_res)

if __name__ == "__main__":
    test_product_variants_bulk_update()
