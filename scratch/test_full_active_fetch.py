import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_paginated_active_fetch():
    client = ShopifyClient()
    
    query = """
    query getActiveProducts($cursor: String) {
      products(first: 250, query: "status:ACTIVE", after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            status
            metafields(first: 5) {
              edges { node { namespace key value } }
            }
            variants(first: 10) {
              edges { node { id sku } }
            }
          }
        }
      }
    }
    """
    
    cursor = None
    total_fetched = 0
    pages = 0
    
    while True:
        res = client.gql(query, {"cursor": cursor})
        if not res or "data" not in res:
            print("❌ Query failed")
            break
            
        p_data = res["data"]["products"]
        edges = p_data["edges"]
        page_info = p_data["pageInfo"]
        
        pages += 1
        total_fetched += len(edges)
        print(f"Page {pages}: Fetched {len(edges)} products (Total: {total_fetched})")
        
        if not page_info["hasNextPage"] or pages >= 3: # Test 3 pages (750 items)
            break
            
        cursor = page_info["endCursor"]
        
    print(f"✅ Successfully tested paginated fetching: {total_fetched} products fetched in {pages} pages!")

if __name__ == "__main__":
    test_paginated_active_fetch()
