import sys
import time

from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_bulk_status_update_fix():
    client = ShopifyClient()
    
    # 1. Create staged upload
    stage_mutation = """
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
    """
    
    stage_res = client.gql(stage_mutation, {
        "input": [{
            "resource": "BULK_MUTATION_VARIABLES",
            "filename": "bulk_draft_test.jsonl",
            "mimeType": "text/jsonl",
            "httpMethod": "POST"
        }]
    })
    
    target = stage_res["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    upload_url = target["url"]
    params = {p["name"]: p["value"] for p in target["parameters"]}
    staged_path = params["key"]
    
    # Test JSONL data (dummy product ID or test product ID)
    jsonl_data = '{"input": {"id": "gid://shopify/Product/8642970484935", "status": "DRAFT"}}\n'
    
    import requests
    files = {'file': ('bulk_draft_test.jsonl', jsonl_data.encode('utf-8'), 'text/jsonl')}
    resp = requests.post(upload_url, data=params, files=files)
    print("S3 Upload response code:", resp.status_code)
    
    # 2. Test valid mutation string for bulkOperationRunMutation
    run_mutation = """
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
    """
    
    # Correct GraphQL mutation string!
    mutation_str = "mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id status } userErrors { field message } } }"
    
    run_res = client.gql(run_mutation, {
        "mutation": mutation_str,
        "stagedUploadPath": staged_path
    })
    print("bulkOperationRunMutation response:", run_res)

if __name__ == "__main__":
    test_bulk_status_update_fix()
