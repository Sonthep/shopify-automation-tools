import sys
import os

# Add parent dir to path so we can import utils
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

query = """
{
  products(first: 10, query: "product_type:'Warewashing & Sanitisation' OR tag:'Commercial Faucets & Plumbing'") {
    edges {
      node {
        title
        productType
        tags
      }
    }
  }
}
"""

def main():
    body = gql(API_URL, HEADERS, query)
    if not body or "data" not in body:
        print("Failed to fetch products")
        return

    products = body["data"]["products"]["edges"]
    
    print("| Title | Type | Tags |")
    print("|---|---|---|")
    for edge in products:
        node = edge["node"]
        title = node.get("title", "")
        product_type = node.get("productType", "")
        tags = ", ".join(node.get("tags") or [])
        print(f"| {title} | {product_type} | {tags} |")

if __name__ == "__main__":
    main()
