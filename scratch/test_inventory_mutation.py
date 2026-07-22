import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_inventory_update():
    client = ShopifyClient()
    
    # 1. Fetch location ID without name
    location_query = """
    {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
    """
    res_loc = client.gql(location_query)
    print("Locations res:", res_loc)
    
    if not res_loc or "data" not in res_loc or not res_loc["data"]["locations"]["edges"]:
        print("❌ Could not fetch locations")
        return
        
    loc_node = res_loc["data"]["locations"]["edges"][0]["node"]
    location_id = loc_node["id"]
    print(f"✅ Found Location ID: {location_id}")
    
    # 2. Fetch 1 item to test inventory update
    product_query = """
    {
      products(first: 1) {
        edges {
          node {
            variants(first: 1) {
              edges {
                node {
                  id
                  inventoryQuantity
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }
    """
    res_prod = client.gql(product_query)
    v_node = res_prod["data"]["products"]["edges"][0]["node"]["variants"]["edges"][0]["node"]
    inv_item_id = v_node["inventoryItem"]["id"]
    curr_qty = v_node["inventoryQuantity"]
    
    print(f"Testing Inventory Item ID: {inv_item_id} (Current Qty: {curr_qty})")
    
    # 3. Test inventorySetQuantities mutation
    mutation = f"""
    mutation {{
      inventorySetQuantities(input: {{
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [
          {{
            inventoryItemId: "{inv_item_id}",
            locationId: "{location_id}",
            quantity: {curr_qty}
          }}
        ]
      }}) {{
        inventoryAdjustmentGroup {{
          id
        }}
        userErrors {{
          field
          message
        }}
      }}
    }}
    """
    
    print("\n🔄 Sending inventorySetQuantities mutation...")
    m_res = client.gql(mutation)
    print("Response:", m_res)

if __name__ == "__main__":
    test_inventory_update()
