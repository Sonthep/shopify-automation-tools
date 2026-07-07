"""
Shared utilities for Shopify GraphQL scripts.
"""
import json
import os
import sys
import time
import requests
import pandas as pd
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows (Thai terminal uses cp874 by default)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Explicit path to .env so it always loads the correct file
_ENV_FILE = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(dotenv_path=_ENV_FILE, override=True)

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
    """Execute a GraphQL query/mutation. Returns body dict or None on error.
    Automatically retries on THROTTLED errors with exponential backoff.
    """
    max_retries = 6
    wait = 2.0
    for attempt in range(max_retries):
        res = requests.post(api_url, json={"query": query, "variables": variables or {}}, headers=headers)
        try:
            body = res.json()
        except ValueError:
            print(f"  [ERR] Invalid JSON response: {res.text[:200]}")
            return None
        if res.status_code != 200:
            print(f"  [ERR] HTTP {res.status_code}: {body}")
            return None
        errors = body.get("errors", [])
        if errors:
            # Check if ALL errors are throttling errors — retry with backoff
            if all(e.get("extensions", {}).get("code") == "THROTTLED" for e in errors):
                print(f"  [WAIT] Throttled -- retrying in {wait:.0f}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue
            print(f"  [ERR] GraphQL errors: {errors}")
            return None
        return body
    print(f"  [ERR] Gave up after {max_retries} retries (throttle)")
    return None


def get_val(row: pd.Series, col: str) -> str | None:
    """Safely get a string value from a DataFrame row, returns None if missing/NaN."""
    if col not in row.index:
        return None
    val = row[col]
    if pd.isna(val):
        return None
    return str(val).strip() or None


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
    """Resolve a list of SKUs to product GIDs.

    If cache_file is given and the file exists, loads the mapping from JSON
    (built by fetch_product_gids.py) without hitting the API.
    Falls back to GraphQL alias batching when no cache is available.
    """
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
    """Resolve a list of SKUs to variant GIDs (needed for price updates).
    Returns {sku: variant_gid or None}.
    """
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
