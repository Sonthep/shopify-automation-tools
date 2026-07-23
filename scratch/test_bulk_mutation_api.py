import sys
import json
import requests
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_full_bulk_mutation_flow():
    client = ShopifyClient()
    
    # 1. Fetch 1 product & variant to test mutation
    fetch_query = """
    {
      products(first: 1) {
        edges {
          node {
            id
            variants(first: 1) {
              edges { node { id price } }
            }
          }
        }
      }
    }
    """
    res = client.gql(fetch_query)
    p_node = res["data"]["products"]["edges"][0]["node"]
    product_gid = p_node["id"]
    variant_gid = p_node["variants"]["edges"][0]["node"]["id"]
    price = p_node["variants"]["edges"][0]["node"]["price"]
    
    print(f"Testing with Product: {product_gid}, Variant: {variant_gid}, Price: {price}")
    
    # 2. Stage upload
    stage_mutation = """
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "price_bulk.jsonl",
        mimeType: "text/jsonl",
        httpMethod: PUT
      }]) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
    """
    stage_res = client.gql(stage_mutation)
    print("Stage upload res:", stage_res)
    
    target = stage_res["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    upload_url = target["url"]
    resource_url = target["resourceUrl"]
    
    # 3. Create JSONL line
    jsonl_line = json.dumps({
        "productId": product_gid,
        "variants": [{"id": variant_gid, "price": price}]
    }) + "\n"
    
    # 4. Upload JSONL
    put_res = requests.put(upload_url, data=jsonl_line.encode("utf-8"), headers={"Content-Type": "text/jsonl"})
    print("PUT res code:", put_res.status_code)
    
    # 5. Run bulk mutation
    run_mutation = """
    mutation bulkRun($stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: "mutation variantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price compareAtPrice } userErrors { field message } } }",
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
    test_full_bulk_mutation_flow()
