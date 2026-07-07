from utils import make_headers, gql, API_URL
import json

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

Q = """
{
  admin: __type(name: "MetafieldAdminAccessInput") { enumValues { name } }
  storefront: __type(name: "MetafieldStorefrontAccessInput") { enumValues { name } }
  customer: __type(name: "MetafieldCustomerAccountAccessInput") { enumValues { name } }
}
"""

body = gql(API_URL, HEADERS, Q)
for k, v in body["data"].items():
    print(k, [e["name"] for e in v["enumValues"]])
