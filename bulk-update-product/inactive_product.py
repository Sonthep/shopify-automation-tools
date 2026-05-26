"""
Bulk-set Shopify products to DRAFT (inactive) status via Bulk Operation API.

Reads a list of Product GIDs from a CSV or TXT file and sets every product's
status to DRAFT using bulkOperationRunMutation → productUpdate.

Supported input formats
-----------------------
CSV  : any CSV that contains a column named "Product GID"
TXT  : one Product GID per line  (gid://shopify/Product/xxxxxxxx)

Usage
-----
    # From CSV (must have "Product GID" column)
    py inactive_product.py --csv data/products.csv

    # From plain-text GID list
    py inactive_product.py --gids data/product_gids.txt

    # Dry-run — build JSONL but do NOT call the API
    py inactive_product.py --csv data/products.csv --dry-run

    # Custom output path
    py inactive_product.py --csv data/products.csv --out output/my_inactive.jsonl
"""

import argparse
import json
import os
import sys
import time

import requests

from utils import make_headers, gql, read_csv_auto, API_URL

# ── Auth ──────────────────────────────────────────────────────
HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

# Column name used in CSVs exported by get_product.py / update_product.py
GID_COLUMN = "Product GID"


# ── Step 1: Collect GIDs ──────────────────────────────────────

def load_gids_from_csv(csv_file: str) -> list[str]:
    """Read Product GIDs from a CSV file (must contain a 'Product GID' column)."""
    df = read_csv_auto(csv_file)
    print(f"  Columns found: {df.columns.tolist()}")
    if GID_COLUMN not in df.columns:
        print(f"[ERR] Column '{GID_COLUMN}' not found in {csv_file}")
        print(f"      Available columns: {df.columns.tolist()}")
        sys.exit(1)
    gids = df[GID_COLUMN].dropna().astype(str).str.strip().tolist()
    gids = [g for g in gids if g.startswith("gid://shopify/Product/")]
    print(f"  {len(gids)} valid Product GIDs loaded from {csv_file}")
    return gids


def load_gids_from_txt(txt_file: str) -> list[str]:
    """Read one GID per line from a plain-text file."""
    gids: list[str] = []
    with open(txt_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("gid://shopify/Product/"):
                gids.append(line)
            elif line and not line.startswith("#"):
                print(f"  [WARN] Skipping invalid GID line: {line!r}")
    print(f"  {len(gids)} valid Product GIDs loaded from {txt_file}")
    return gids


# ── Step 2: Build JSONL ───────────────────────────────────────

def build_inactive_jsonl(gids: list[str], jsonl_file: str) -> int:
    """Write one JSON line per product: sets status = DRAFT."""
    os.makedirs(os.path.dirname(jsonl_file), exist_ok=True)
    count = 0
    with open(jsonl_file, "w", encoding="utf-8") as f:
        for gid in gids:
            line = json.dumps({"input": {"id": gid, "status": "DRAFT"}})
            f.write(line + "\n")
            count += 1
    print(f"  {count} rows written → {jsonl_file}")
    return count


# ── Step 3: Staged upload ─────────────────────────────────────

def create_staged_upload(filename: str = "inactive_bulk.jsonl") -> dict | None:
    """Request a signed GCS upload URL from Shopify."""
    query = f"""
    mutation {{
      stagedUploadsCreate(input: {{
        resource: BULK_MUTATION_VARIABLES,
        filename: "{filename}",
        mimeType: "text/jsonl",
        httpMethod: PUT
      }}) {{
        stagedTargets {{ url resourceUrl parameters {{ name value }} }}
        userErrors {{ field message }}
      }}
    }}"""
    body = gql(API_URL, HEADERS, query)
    if not body:
        return None
    data = body["data"]["stagedUploadsCreate"]
    if data.get("userErrors"):
        print(f"[ERR] stagedUploadsCreate: {data['userErrors']}")
        return None
    target = data["stagedTargets"][0]
    print(f"  Staged upload created: {target['resourceUrl']}")
    return target


def upload_jsonl(target: dict, filepath: str) -> str:
    """PUT the JSONL file to the signed GCS URL."""
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"  Uploaded {filepath}  (HTTP {res.status_code})")
    return target["resourceUrl"]


# ── Step 4: Run bulk mutation ─────────────────────────────────

BULK_MUTATION = """
mutation BulkInactive($stagedUploadPath: String!) {
  bulkOperationRunMutation(
    mutation: "mutation setDraft($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }",
    stagedUploadPath: $stagedUploadPath
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}"""


def run_bulk_mutation(resource_url: str) -> dict | None:
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"[ERR] Bulk mutation: {op['userErrors']}")
        return None
    print(f"  Bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Step 5: Poll until done ───────────────────────────────────

POLL_QUERY = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"


def poll_status(interval: int = 15) -> str | None:
    """Block until the bulk mutation completes. Returns result URL or None."""
    while True:
        body = gql(API_URL, HEADERS, POLL_QUERY)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print("[ERR] No active bulk operation found.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows processed")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[ERR] Bulk operation failed: {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Step 6: (Optional) Download & verify result ───────────────

def download_and_summarise(result_url: str) -> None:
    """Download the bulk result JSONL and print a summary of any userErrors."""
    if not result_url:
        return
    print(f"\nDownloading result from: {result_url}")
    resp = requests.get(result_url, timeout=120)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} result lines")

    errors = [l for l in lines if l.get("userErrors")]
    if errors:
        print(f"  ⚠️  {len(errors)} line(s) with userErrors:")
        for e in errors[:10]:
            print(f"      {e}")
    else:
        print(f"  ✅ No userErrors detected — all products set to DRAFT.")


# ── Main ──────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Bulk-set Shopify products to DRAFT (inactive) via Bulk Operation API"
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--csv",
        metavar="FILE",
        help='CSV file with a "Product GID" column (e.g. output from get_product.py)',
    )
    src.add_argument(
        "--gids",
        metavar="FILE",
        help="Plain-text file with one Product GID per line",
    )
    parser.add_argument(
        "--out",
        default=os.path.join(BASE_DIR, "output", "inactive_bulk.jsonl"),
        metavar="FILE",
        help="Path for the generated JSONL file (default: output/inactive_bulk.jsonl)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build the JSONL file but skip the Shopify API calls",
    )
    parser.add_argument(
        "--no-verify",
        action="store_true",
        help="Skip downloading the bulk-operation result for verification",
    )
    args = parser.parse_args()

    # ── 1. Load GIDs ──
    print("\n── Loading Product GIDs ──")
    if args.csv:
        csv_path = args.csv if os.path.isabs(args.csv) else os.path.join(BASE_DIR, args.csv)
        gids = load_gids_from_csv(csv_path)
    else:
        txt_path = args.gids if os.path.isabs(args.gids) else os.path.join(BASE_DIR, args.gids)
        gids = load_gids_from_txt(txt_path)

    if not gids:
        print("[INFO] No valid Product GIDs found — nothing to do.")
        sys.exit(0)

    # ── 2. Build JSONL ──
    print(f"\n── Building JSONL ({len(gids)} products → DRAFT) ──")
    jsonl_file = args.out if os.path.isabs(args.out) else os.path.join(BASE_DIR, args.out)
    os.makedirs(os.path.dirname(jsonl_file), exist_ok=True)
    count = build_inactive_jsonl(gids, jsonl_file)

    if args.dry_run:
        print(f"\n[DRY-RUN] JSONL written to {jsonl_file} — API calls skipped.")
        sys.exit(0)

    if count == 0:
        print("[INFO] No rows to upload — exiting.")
        sys.exit(0)

    # ── 3. Staged upload ──
    print("\n── Creating staged upload ──")
    filename = os.path.basename(jsonl_file)
    target = create_staged_upload(filename)
    if not target:
        sys.exit(1)

    # ── 4. Upload JSONL ──
    print("\n── Uploading JSONL ──")
    resource_url = upload_jsonl(target, jsonl_file)

    # ── 5. Run bulk mutation ──
    print("\n── Running bulk mutation (productUpdate → DRAFT) ──")
    op = run_bulk_mutation(resource_url)
    if not op:
        sys.exit(1)

    # ── 6. Poll until done ──
    print("\n── Polling bulk operation ──")
    result_url = poll_status()

    # ── 7. Verify ──
    if result_url and not args.no_verify:
        download_and_summarise(result_url)

    print(f"\n{'='*50}")
    if result_url:
        print(f"✅ Bulk inactive done!  {count} product(s) set to DRAFT.")
        print(f"   Result URL: {result_url}")
    else:
        print("❌ Bulk operation did not complete successfully.")
        sys.exit(1)


if __name__ == "__main__":
    main()
