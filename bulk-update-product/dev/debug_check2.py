"""Check if metafield was saved after direct mutation."""
import json
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
GID = "gid://shopify/Product/8645654937799"

body = gql(API_URL, HEADERS, """
query($id: ID!) {
  product(id: $id) {
    metafields(first: 50, namespace: "specs") {
      edges { node { key value } }
    }
  }
}
""", {"id": GID})
print(json.dumps(body["data"], indent=2, ensure_ascii=False))
