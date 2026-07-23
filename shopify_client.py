"""
Centralized Shopify API Client & Helper Utilities.
Supports GraphQL, REST requests, automatic token refresh, throttle handling, and dynamic path resolution.
"""

import os
import sys
import time
import requests
from pathlib import Path
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def get_project_root() -> Path:
    """Returns the absolute Path of the project root directory."""
    return Path(__file__).resolve().parent


def resolve_path(path_str: str | Path) -> Path:
    """Resolves a path relative to the project root unless it's already an absolute path."""
    p = Path(path_str)
    if p.is_absolute():
        return p
    return get_project_root() / p


# Load .env file from project root
ENV_FILE = get_project_root() / ".env"
load_dotenv(dotenv_path=ENV_FILE, override=True)


class ShopifyClient:
    def __init__(self, shop_name: str | None = None, token_env: str = "SHOPIFY_ACCESS_TOKEN", api_version: str = "2026-01"):
        self.shop = shop_name or os.getenv("SHOP_NAME", "sevenfive-4062.myshopify.com")
        self.shop = self.shop.replace("https://", "").replace("http://", "").strip()
        self.api_version = api_version
        self.token_env = token_env
        self.graphql_url = f"https://{self.shop}/admin/api/{self.api_version}/graphql.json"
        self.headers = self._build_headers()

    def _build_headers(self) -> dict:
        token = os.getenv(self.token_env)
        if not token:
            token = self.refresh_token()
        if not token:
            raise RuntimeError(f"Could not acquire token for '{self.token_env}'")
        return {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
        }

    def refresh_token(self) -> str | None:
        """Call gen_token script to generate a fresh token."""
        try:
            root_dir = str(get_project_root())
            if root_dir not in sys.path:
                sys.path.insert(0, root_dir)
            from gen_token import generate_token
            new_token = generate_token(str(ENV_FILE))
            if new_token:
                load_dotenv(dotenv_path=ENV_FILE, override=True)
                return new_token
        except Exception as e:
            print(f"⚠️ Failed to auto-generate token: {e}")
        return None

    def gql(self, query: str, variables: dict | None = None, max_retries: int = 6) -> dict | None:
        """Execute a GraphQL query/mutation with throttle handling and 401 retry."""
        wait = 2.0
        headers = self.headers.copy()

        for attempt in range(max_retries):
            try:
                res = requests.post(
                    self.graphql_url,
                    json={"query": query, "variables": variables or {}},
                    headers=headers,
                    timeout=30
                )
            except Exception as e:
                print(f"  [ERR] Connection error (attempt {attempt + 1}/{max_retries}): {e}")
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue

            if res.status_code == 401:
                print(f"  [WARN] HTTP 401 Unauthorized -- refreshing token (attempt {attempt + 1}/{max_retries})...")
                new_token = self.refresh_token()
                if new_token:
                    headers["X-Shopify-Access-Token"] = new_token
                    self.headers["X-Shopify-Access-Token"] = new_token
                    continue

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
                if all(e.get("extensions", {}).get("code") == "THROTTLED" for e in errors):
                    print(f"  [WAIT] Throttled -- retrying in {wait:.0f}s (attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait)
                    wait = min(wait * 2, 60)
                    continue
                print(f"  [ERR] GraphQL errors: {errors}")
                return None

            return body

        print(f"  [ERR] Max retries ({max_retries}) reached.")
        return None


# Standalone shortcut helper function
def gql_request(query: str, variables: dict | None = None, token_env: str = "SHOPIFY_ACCESS_TOKEN") -> dict | None:
    client = ShopifyClient(token_env=token_env)
    return client.gql(query, variables)


if __name__ == "__main__":
    print(f"Project Root: {get_project_root()}")
    client = ShopifyClient()
    print(f"Shopify Client initialized for {client.shop}")
