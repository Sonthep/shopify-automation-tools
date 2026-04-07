import json, os
from dotenv import load_dotenv
load_dotenv('../.env')
from utils import gql, API_URL, make_headers

HEADERS = make_headers('SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT')
sku = 'PIM1-R60-3'

query = """
query($q: String!) {
  productVariants(first: 5, query: $q) {
    edges {
      node {
        sku
        inventoryItem {
          id
          inventoryLevels(first: 3) {
            edges {
              node {
                location { id }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
}"""

body = gql(API_URL, HEADERS, query, {'q': f'sku:{sku}'})
print(json.dumps(body, indent=2))
