"""
Centralized Shopify API Client & Helper Utilities.
Supports GraphQL, REST requests, automatic token refresh, throttle handling, and dynamic path resolution.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
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

# ── Dry-run & mutation audit log ────────────────────────────────────────────
# Set DRY_RUN=true (env var or .env) to log every mutation that WOULD be sent
# without actually calling the Shopify API. Every mutation (dry-run or real)
# is always appended to logs/mutations.log for auditing regardless of this flag.
DRY_RUN = os.getenv("DRY_RUN", "").strip().lower() in ("1", "true", "yes")
LOG_DIR = get_project_root() / "logs"
MUTATION_LOG_FILE = LOG_DIR / "mutations.log"
_MUTATION_RE = re.compile(r"^\s*mutation\b", re.IGNORECASE)
_LOG_FIELD_MAX_CHARS = 5000


def _is_mutation(query: str) -> bool:
    return bool(_MUTATION_RE.match(query or ""))


def _truncate(value: str) -> str:
    if len(value) <= _LOG_FIELD_MAX_CHARS:
        return value
    return value[:_LOG_FIELD_MAX_CHARS] + f"...<truncated {len(value) - _LOG_FIELD_MAX_CHARS} chars>"


def _log_mutation(token_env: str, query: str, variables: dict | None, dry_run: bool) -> None:
    """Append an audit-trail entry for an outgoing mutation. Never raises."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "script": Path(sys.argv[0]).name if sys.argv and sys.argv[0] else "unknown",
            "token_env": token_env,
            "dry_run": dry_run,
            "query": _truncate(query.strip()),
            "variables": _truncate(json.dumps(variables or {}, ensure_ascii=False, default=str)),
        }
        with open(MUTATION_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"  [WARN] Failed to write mutation audit log: {e}")


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
        """Execute a GraphQL query/mutation with throttle handling and 401 retry.

        Every mutation is appended to logs/mutations.log for auditing. If DRY_RUN
        is enabled, mutations are logged but NOT sent to Shopify -- this returns
        None instead, same as any other failed call, so callers using the common
        `(body or {}).get("data", {})` pattern degrade gracefully. Non-mutation
        queries always execute normally, dry-run or not.
        """
        if _is_mutation(query):
            _log_mutation(self.token_env, query, variables, DRY_RUN)
            if DRY_RUN:
                preview = " ".join(query.split())[:200]
                print(f"  [DRY-RUN] Skipped mutation ({self.token_env}): {preview}...")
                return None

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
