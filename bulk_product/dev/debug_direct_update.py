"""Test direct productUpdate mutation (non-bulk) to diagnose metafield issue."""
import json
import pandas as pd
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

df = pd.read_csv("data/update_metafieds_value_colged.csv", dtype=str)
row = df.dropna(subset=["GID"]).iloc[0]
gid = row["GID"].strip()
print("Testing GID:", gid)

MUTATION = """
mutation updateMeta($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id title }
    userErrors { field message }
  }
}
"""

variables = {
    "input": {
        "id": gid,
        "metafields": [
            {
                "namespace": "specs",
                "key": "voltage",
                "value": str(row.get("specs.voltage", "220")).strip(),
                "type": "single_line_text_field",
            }
        ],
    }
}

print("Input:", json.dumps(variables, indent=2, ensure_ascii=False))
body = gql(API_URL, HEADERS, MUTATION, variables)
print("Response:", json.dumps(body, indent=2, ensure_ascii=False))
