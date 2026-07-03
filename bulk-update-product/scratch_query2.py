import sys, os
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

query = """
{
  products(first: 1, query: "title:'36 COMPARTMENT CUP RACK'") {
    edges {
      node {
        id
        title
        description
        descriptionHtml
        seo { title description }
      }
    }
  }
}
"""

res = gql(API_URL, HEADERS, query)
print(res)
