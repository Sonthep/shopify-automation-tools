import sys
import json
import requests
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_bulk_inventory_mutation():
    client = ShopifyClient()
    
    # 1. Fetch location ID & 1 item
    loc_res = client.gql("{ locations(first: 1) { edges { node { id } } } }")
    location_id = loc_res["data"]["locations"]["edges"][0]["node"]["id"]
    
    prod_res = client.gql("{ products(first: 1) { edges { node { variants(first: 1) { edges { node { inventoryQuantity inventoryItem { id } } } } } } } }")
    v_node = prod_res["data"]["products"]["edges"][0]["node"]["variants"]["edges"][0]["node"]
    inv_item_id = v_node["inventoryItem"]["id"]
    qty = v_node["inventoryQuantity"]
    
    print(f"Location: {location_id}, InvItem: {inv_item_id}, Qty: {qty}")
    
    # 2. Stage upload
    stage_mutation = """
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "inventory_bulk.jsonl",
        mimeType: "text/jsonl",
        httpMethod: PUT
      }]) {
        stagedTargets { url resourceUrl }
        userErrors { field message }
      }
    }
    """
    stage_res = client.gql(stage_mutation)
    target = stage_res["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    upload_url = target["url"]
    resource_url = target["resourceUrl"]
    
    # 3. Create JSONL line
    jsonl_line = json.dumps({
        "input": {
            "name": "available",
            "reason": "correction",
            "ignoreCompareQuantity": True,
            "quantities": [{
                "inventoryItemId": inv_item_id,
                "locationId": location_id,
                "quantity": int(qty)
            }]
        }
    }) + "\n"
    
    # 4. PUT Upload
    put_res = requests.put(upload_url, data=jsonl_line.encode("utf-8"), headers={"Content-Type": "text/jsonl"})
    print("PUT res code:", put_res.status_code)
    
    # 5. Run bulk mutation
    run_mutation = """
    mutation bulkRun($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation invSet($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }",
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
    """
    run_res = client.gql(run_mutation, {"stagedUploadPath": resource_url})
    print("Run bulk mutation res:", run_res)

if __name__ == "__main__":
    test_bulk_inventory_mutation()
