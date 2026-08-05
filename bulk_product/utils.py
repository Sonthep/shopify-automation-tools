"""
Shared utilities for Shopify GraphQL scripts in bulk_product.
Refactored to integrate with central shopify_client.py.
"""
import json
import os
import sys
import time
import requests
import pandas as pd
from pathlib import Path
from dotenv import load_dotenv

# Add project root to sys.path to import shopify_client
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from shopify_client import ShopifyClient, get_project_root, resolve_path

_ENV_FILE = os.path.join(_PROJECT_ROOT, ".env")
load_dotenv(dotenv_path=_ENV_FILE, override=True)

SHOP    = os.getenv("SHOP_NAME", "sevenfive-4062.myshopify.com")
API_VER = "2026-01"
API_URL = f"https://{SHOP}/admin/api/{API_VER}/graphql.json"


def make_headers(token_env: str) -> dict:
    """Build Shopify API headers from a named env var."""
    client = ShopifyClient(shop_name=SHOP, token_env=token_env, api_version=API_VER)
    return client.headers


def gql(api_url: str, headers: dict, query: str, variables: dict = None) -> dict | None:
    """Execute a GraphQL query/mutation. Delegates to ShopifyClient."""
    token = headers.get("X-Shopify-Access-Token")
    client = ShopifyClient(shop_name=SHOP, api_version=API_VER)
    if token:
        client.headers["X-Shopify-Access-Token"] = token
    return client.gql(query, variables)


def get_val(row: pd.Series, col: str) -> str | None:
    """Safely get a string value from a DataFrame row.

    If the column exists, always return a string (empty string for blank/NaN)
    so blank CSV cells can be distinguished from a missing column.
    Returns None only when the requested column is not present.
    """
    if col not in row.index:
        return None
    val = row[col]
    if pd.isna(val):
        return ""
    return str(val).strip()


def read_csv_auto(path: str, **kwargs) -> pd.DataFrame:
    """Read CSV with automatic encoding detection (utf-8-sig → cp874 → latin-1)."""
    for enc in ("utf-8-sig", "cp874", "latin-1"):
        try:
            return pd.read_csv(path, encoding=enc, **kwargs)
        except (UnicodeDecodeError, ValueError):
            continue
    raise ValueError(f"Cannot decode CSV file: {path}")


def get_product_gids_by_skus(
    api_url: str,
    headers: dict,
    skus: list,
    batch_size: int = 50,
    cache_file: str = None,
) -> dict:
    """Resolve a list of SKUs to product GIDs."""
    if cache_file and os.path.exists(cache_file):
        with open(cache_file, encoding="utf-8") as f:
            cache: dict = json.load(f)
        gid_map = {sku: cache.get(sku) for sku in skus}
        missing = [sku for sku, gid in gid_map.items() if gid is None]
        if missing:
            print(f"  ⚠️  {len(missing)} SKU(s) not in cache: {missing[:5]}")
        print(f"  ✅ Loaded {len(gid_map)} GIDs from cache ({cache_file})")
        return gid_map

    # --- fallback: query API ---
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


def get_variant_gids_by_skus(
    api_url: str,
    headers: dict,
    skus: list,
    batch_size: int = 50,
) -> dict:
    """Resolve a list of SKUs to variant GIDs."""
    gid_map = {}
    for i in range(0, len(skus), batch_size):
        batch = skus[i:i + batch_size]
        aliases = "\n".join([
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") '
            f'{{ edges {{ node {{ id }} }} }}'
            for j, sku in enumerate(batch)
        ])
        body = gql(api_url, headers, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            gid_map[sku] = edges[0]["node"]["id"] if edges else None
        print(f"  Variant GIDs resolved {min(i + batch_size, len(skus))}/{len(skus)}")
        time.sleep(0.5)
    return gid_map
