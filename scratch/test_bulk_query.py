import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_bulk_operation_query():
    client = ShopifyClient()
    
    bulk_mutation = """
    mutation {
      bulkOperationRunQuery(
       query: \"\"\"
        {
          products(query: "status:ACTIVE") {
            edges {
              node {
                id
                status
                good_id: metafield(namespace: "custom", key: "good_id") {
                  value
                }
                variants {
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
       \"\"\"
      ) {
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
    
    res = client.gql(bulk_mutation)
    print("Bulk Operation Trigger Result:", res)
    
    poll_query = """
    {
      currentBulkOperation {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        fileSize
        url
      }
    }
    """
    
    start_time = time.time()
    while True:
        poll_res = client.gql(poll_query)
        op = poll_res.get("data", {}).get("currentBulkOperation")
        if not op:
            print("No bulk operation found.")
            break
            
        status = op["status"]
        print(f"Status: {status} | Objects: {op.get('objectCount')} | FileSize: {op.get('fileSize')} bytes")
        
        if status == "COMPLETED":
            print(f"✅ BULK OPERATION COMPLETED IN {time.time() - start_time:.2f} SECONDS!")
            print(f"Download URL: {op.get('url')}")
            break
        elif status in ["FAILED", "CANCELED"]:
            print("❌ Bulk operation failed/canceled:", op)
            break
            
        time.sleep(1)

if __name__ == "__main__":
    test_bulk_operation_query()
