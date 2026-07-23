import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_fetch_status_active_10():
    client = ShopifyClient()
    
    # Query 10 active products directly from Shopify API to verify data structure
    query = """
    {
      products(first: 10, query: "status:ACTIVE") {
        edges {
          node {
            id
            handle
            status
            metafields(first: 5) {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    }
    """
    res = client.gql(query)
    print("Fetched 10 active products from Shopify:")
    if res and "data" in res:
        for p in res["data"]["products"]["edges"]:
            p_node = p["node"]
            v_node = p_node["variants"]["edges"][0]["node"] if p_node["variants"]["edges"] else {}
            
            # Find custom.good_id
            good_id = ""
            for mf in p_node.get("metafields", {}).get("edges", []):
                m = mf["node"]
                if m["namespace"] == "custom" and m["key"] == "good_id":
                    good_id = m["value"]
                    
            print(f"GoodID: {good_id} | SKU: {v_node.get('sku')} | Product GID: {p_node['id']} | Variant GID: {v_node.get('id')} | Status: {p_node['status']}")

if __name__ == "__main__":
    test_fetch_status_active_10()
