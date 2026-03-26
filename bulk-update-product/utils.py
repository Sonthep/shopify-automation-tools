"""
Shared utilities for Shopify GraphQL scripts.
"""
import os
import time
import requests
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

SHOP    = os.getenv("SHOP_NAME")
API_VER = "2026-01"
API_URL = f"https://{SHOP}/admin/api/{API_VER}/graphql.json"


def make_headers(token_env: str) -> dict:
    """Build Shopify API headers from a named env var."""
    token = os.getenv(token_env)
    if not token:
        raise RuntimeError(f"Environment variable '{token_env}' is not set.")
    print(f"SHOP : {SHOP}")
    print(f"TOKEN: {token[:10]}...")
    return {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
    }


def gql(api_url: str, headers: dict, query: str, variables: dict = None) -> dict | None:
    """Execute a GraphQL query/mutation. Returns body dict or None on error."""
    res = requests.post(api_url, json={"query": query, "variables": variables or {}}, headers=headers)
    try:
        body = res.json()
    except ValueError:
        print(f"  ❌ Invalid JSON response: {res.text[:200]}")
        return None
    if res.status_code != 200:
        print(f"  ❌ HTTP {res.status_code}: {body}")
        return None
    if body.get("errors"):
        print(f"  ❌ GraphQL errors: {body['errors']}")
        return None
    return body


def get_val(row: pd.Series, col: str) -> str | None:
    """Safely get a string value from a DataFrame row, returns None if missing/NaN."""
    if col not in row.index:
        return None
    val = row[col]
    if pd.isna(val):
        return None
    return str(val).strip() or None


def get_product_gids_by_skus(api_url: str, headers: dict, skus: list, batch_size: int = 50) -> dict:
    """Resolve a list of SKUs to product GIDs via GraphQL aliases."""
    gid_map = {}
    for i in range(0, len(skus), batch_size):
        batch   = skus[i:i + batch_size]
        aliases = "\n".join([
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") '
            f'{{ edges {{ node {{ product {{ id }} }} }} }}'
            for j, sku in enumerate(batch)
        ])
        body = gql(api_url, headers, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            gid_map[sku] = edges[0]["node"]["product"]["id"] if edges else None
        print(f"  Resolved {min(i + batch_size, len(skus))}/{len(skus)} SKUs")
        time.sleep(0.5)
    return gid_map
