import json
import pandas as pd
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

df = pd.read_csv("data/update_metafieds_value_colged.csv", dtype=str)
gid = df["GID"].dropna().iloc[0].strip()
print("GID:", gid)

q = """
query($id: ID!) {
  product(id: $id) {
    id title
    metafields(first: 20, namespace: "specs") {
      edges { node { namespace key value type } }
    }
  }
}
"""
body = gql(API_URL, HEADERS, q, {"id": gid})
print(json.dumps(body, indent=2, ensure_ascii=False))
