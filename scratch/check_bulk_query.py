import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import time
import requests
from shopify_client import ShopifyClient

client = ShopifyClient()

INNER_QUERY = """
{
  products {
    edges {
      node {
        id
        handle
        title
        status
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
"""

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

res = client.gql(query, variables={"query": INNER_QUERY})
print("Start bulk op:", res)
op_id = res["data"]["bulkOperationRunQuery"]["bulkOperation"]["id"]

poll_query = f"""
{{
  node(id: "{op_id}") {{
    ... on BulkOperation {{
      id
      status
      objectCount
      url
    }}
  }}
}}
"""

while True:
    time.sleep(5)
    st = client.gql(poll_query)
    node = st["data"]["node"]
    print(f"Status: {node['status']}, Objects: {node['objectCount']}")
    if node["status"] == "COMPLETED":
        url = node["url"]
        print("URL:", url)
        r = requests.get(url)
        lines = r.text.strip().split('\n')
        print("Total JSONL lines downloaded:", len(lines))
        products = [l for l in lines if '"/Product/' in l and '__parentId' not in l]
        variants = [l for l in lines if '"/ProductVariant/' in l]
        print(f"Products count: {len(products)}")
        print(f"Variants count: {len(variants)}")
        break
