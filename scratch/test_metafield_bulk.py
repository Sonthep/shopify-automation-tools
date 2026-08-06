import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import time
import requests
from shopify_client import ShopifyClient

client = ShopifyClient()

query = """
mutation BulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
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

# Query 1: with metafields
query1 = """
{
  products {
    edges {
      node {
        id
        handle
        title
        vendor
        productType
        tags
        status
        publishedAt
        variants {
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
        images {
          edges {
            node {
              id
              url
            }
          }
        }
        metafields {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  }
}
"""

res = client.gql(query, variables={"query": query1})
print("Start query with metafields:", res)
op_id = res["data"]["bulkOperationRunQuery"]["bulkOperation"]["id"]

poll_query = f"""
{{
  node(id: "{op_id}") {{
    ... on BulkOperation {{
      id
      status
      objectCount
      rootObjectCount
      url
    }}
  }}
}}
"""

while True:
    time.sleep(5)
    st = client.gql(poll_query)
    node = st["data"]["node"]
    print(f"Status: {node['status']}, Objects: {node['objectCount']}, Root: {node.get('rootObjectCount')}")
    if node["status"] == "COMPLETED":
        url = node["url"]
        r = requests.get(url)
        lines = r.text.strip().split('\n')
        print("Total JSONL lines:", len(lines))
        products = [l for l in lines if '"/Product/' in l and '__parentId' not in l]
        print(f"Products count: {len(products)}")
        break
