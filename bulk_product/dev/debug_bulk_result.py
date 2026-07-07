"""Download and inspect the bulk operation result file."""
import json
import requests
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

body = gql(API_URL, HEADERS, "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }")
op = (body or {}).get("data", {}).get("currentBulkOperation")
print("Bulk op:", json.dumps(op, indent=2))

result_url = (op or {}).get("url")
if result_url:
    print("\nDownloading result file...")
    resp = requests.get(result_url, timeout=30)
    print(f"HTTP {resp.status_code}, length={len(resp.text)}")
    print("--- RAW CONTENT ---")
    print(repr(resp.text[:2000]))
else:
    print("No result URL available.")
