"""
ดึง Metafield Definitions ของ Product ทั้งหมด
Output: output/all_metafields.csv
Columns: name (Definition name), key (namespace.key)

Usage:
    py get_metafield.py
    py get_metafield.py --output output/my_metafields.csv
"""
import os
import sys
import argparse
import pandas as pd
from utils import make_headers, gql, API_URL

HEADERS    = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
OUTPUT_CSV = os.path.join(OUTPUT_DIR, "all_metafields.csv")

QUERY = """
query getMetafieldDefs($cursor: String) {
  metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        name
        namespace
        key
        type { name }
      }
    }
  }
}
"""


# ── Fetch all definitions (paginated) ────────────────────────
def fetch_definitions() -> list[dict]:
    rows   = []
    cursor = None
    while True:
        body = gql(API_URL, HEADERS, QUERY, {"cursor": cursor})
        if not body:
            break
        data      = body["data"]["metafieldDefinitions"]
        edges     = data["edges"]
        page_info = data["pageInfo"]
        for edge in edges:
            node = edge["node"]
            rows.append({
                "name": node["name"],
                "key":  f"{node['namespace']}.{node['key']}",
                "type": node["type"]["name"],
            })
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]
    return rows


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export product metafield definitions")
    parser.add_argument("--output", default=OUTPUT_CSV, help="Output CSV path")
    args = parser.parse_args()

    print("🔍 Fetching metafield definitions...")
    rows = fetch_definitions()

    if not rows:
        print("⚠️  No definitions found.")
        sys.exit(0)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    df = pd.DataFrame(rows).sort_values("key").reset_index(drop=True)
    df.to_csv(args.output, index=False, encoding="utf-8-sig")

    print(f"✅ Exported {len(df)} definitions → {args.output}")
    print(df.to_string(index=False))

