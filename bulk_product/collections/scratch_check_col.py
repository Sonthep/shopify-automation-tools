import sys, os
sys.path.insert(0, "..")
from utils import make_headers, gql, API_URL

H = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

q_cols = """
query {
  collections(first: 250) {
    edges {
      node {
        id
        title
        handle
      }
    }
  }
}
"""

res = gql(API_URL, H, q_cols)
edges = res.get("data", {}).get("collections", {}).get("edges", [])
print(f"Total collections found: {len(edges)}")

for edge in edges:
    node = edge["node"]
    if "cooking" in node["handle"].lower() or "cooking" in node["title"].lower():
        print(f"\nCollection: {node['title']} ({node['handle']}) -> {node['id']}")
        
        q_trans = """
        query getTrans($id: ID!) {
          translatableResource(resourceId: $id) {
            translations(locale: "th") {
              key
              value
            }
            translatableContent {
              key
              value
              digest
            }
          }
        }
        """
        t_res = gql(API_URL, H, q_trans, {"id": node["id"]})
        resource = (t_res or {}).get("data", {}).get("translatableResource", {})
        print("  Translations (th):", resource.get("translations"))
        print("  Translatable Content:", resource.get("translatableContent", []))
