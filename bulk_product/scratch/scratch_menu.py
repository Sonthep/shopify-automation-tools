import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import make_headers, gql, API_URL
import json

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

query = """
mutation {
  menuCreate(menu: {
    title: "Test Menu"
    handle: "test-menu"
    items: [
      {
        title: "Home",
        type: SHOP_POLICY,
        url: "/"
      }
    ]
  }) {
    menu {
      id
      title
      handle
    }
    userErrors {
      field
      message
    }
  }
}
"""

res = gql(API_URL, HEADERS, query)
print(json.dumps(res, indent=2))
