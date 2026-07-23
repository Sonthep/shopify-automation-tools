"""
Bulk create Shopify collections via Bulk Operation API.

Required CSV columns:
  - Title            : Collection name (required)

Optional CSV columns:
  - Handle           : URL handle (Shopify auto-generates if blank)
  - Page Title       : SEO page title (seo.title)
  - Meta Description : SEO meta description (seo.description)
  - Condition        : Rules → creates a SMART collection if provided.
      Format A — JSON array:
        [{"column":"TAG","relation":"EQUALS","condition":"shoes"}]
        Prefix with "OR|" for OR logic:
        OR|[{"column":"TAG","relation":"EQUALS","condition":"shoes"}]
      Format B — plain text:
        TAG EQUALS shoes AND TAG EQUALS boots
        TAG EQUALS shoes OR TAG EQUALS boots

Usage:
    py create_collections.py --csv ../data/new_collections.xlsx
    py create_collections.py --csv ../data/new_collections.xlsx --dry-run
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import time

import pandas as pd
import requests

from utils import make_headers, gql, read_csv_auto, API_URL, get_val

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

COL_TITLE     = "Title"
COL_HANDLE    = "Handle"
COL_PAGE      = "Page Title"
COL_META      = "Meta Description"
COL_CONDITION = "Condition"

OUTPUT_DIR = os.path.join(BASE_DIR, "output")

BULK_MUTATION = (
    "mutation crtCol($input: CollectionInput!) { "
    "collectionCreate(input: $input) { "
    "collection { id title handle } "
    "userErrors { field message } } }"
)


# ── Condition parser ──────────────────────────────────────────

def _parse_condition(raw: str) -> tuple[bool, list[dict]] | None:
    if not raw:
        return None
    raw = raw.strip()

    disjunctive = False
    if raw.upper().startswith("OR|"):
        disjunctive = True
        raw = raw[3:].strip()
    if raw.startswith("["):
        try:
            rules = json.loads(raw)
            return (disjunctive, rules)
        except json.JSONDecodeError as e:
            print(f"  [WARN] Cannot parse Condition JSON: {e}  →  skipping rules")
            return None

    if " OR " in raw:
        disjunctive = True
        parts = raw.split(" OR ")
    elif " AND " in raw:
        disjunctive = False
        parts = raw.split(" AND ")
    else:
        parts = [raw]

    COLUMNS = {
        "TAG", "TITLE", "TYPE", "VENDOR",
        "VARIANT_PRICE", "VARIANT_COMPARE_AT_PRICE", "VARIANT_WEIGHT",
        "VARIANT_INVENTORY", "VARIANT_TITLE",
        "PRODUCT_METAFIELD_DEFINITION", "VARIANT_METAFIELD_DEFINITION",
        "PRODUCT_TAXONOMY_NODE_ID",
    }
    RELATIONS = {
        "EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN",
        "STARTS_WITH", "ENDS_WITH", "CONTAINS", "NOT_CONTAINS",
    }

    rules = []
    for part in parts:
        tokens = part.strip().split(" ", 2)
        if len(tokens) < 3:
            print(f"  [WARN] Cannot parse rule segment: '{part}'  →  skipping")
            continue
        col, rel, cond = tokens[0].upper(), tokens[1].upper(), tokens[2]
        if col not in COLUMNS or rel not in RELATIONS:
            print(f"  [WARN] Unknown column/relation: {col} {rel}  →  skipping")
            continue
        rules.append({"column": col, "relation": rel, "condition": cond})

    return (disjunctive, rules) if rules else None


# ── Read CSV/Excel ────────────────────────────────────────────

def _read_df(path: str) -> pd.DataFrame:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path, dtype=str).fillna("")
    return read_csv_auto(path)


# ── Step 1: Build JSONL ───────────────────────────────────────

def build_jsonl(df: pd.DataFrame, out_path: str) -> int:
    if COL_TITLE not in df.columns:
        print(f"[ERR] Column '{COL_TITLE}' is required.")
        sys.exit(1)

    count = skipped = 0
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            title = get_val(row, COL_TITLE)
            if not title:
                skipped += 1
                continue

            inp: dict = {"title": title}

            if v := get_val(row, COL_HANDLE):
                inp["handle"] = v

            seo: dict = {}
            if v := get_val(row, COL_PAGE):
                seo["title"] = v
            if v := get_val(row, COL_META):
                seo["description"] = v
            if seo:
                inp["seo"] = seo

            raw_cond = get_val(row, COL_CONDITION) or ""
            parsed = _parse_condition(raw_cond)
            if parsed is not None:
                disjunctive, rules = parsed
                inp["ruleSet"] = {
                    "appliedDisjunctively": disjunctive,
                    "rules": rules,
                }

            f.write(json.dumps({"input": inp}) + "\n")
            count += 1

    print(f"  {count} rows written → {out_path}  ({skipped} skipped)")
    return count


# ── Step 2: Staged upload ─────────────────────────────────────

def create_staged_upload(filename: str) -> dict | None:
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
    return data["stagedTargets"][0]


def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"  Uploaded {filepath}  (HTTP {res.status_code})")
    return target["resourceUrl"]


# ── Step 3: Run bulk mutation ─────────────────────────────────

def run_bulk_mutation(resource_url: str) -> dict | None:
    outer = f"""
    mutation BulkCreateCollections($stagedUploadPath: String!) {{
      bulkOperationRunMutation(
        mutation: "{BULK_MUTATION}",
        stagedUploadPath: $stagedUploadPath
      ) {{
        bulkOperation {{ id status }}
        userErrors {{ field message }}
      }}
    }}"""
    body = gql(API_URL, HEADERS, outer, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"[ERR] Bulk mutation: {op['userErrors']}")
        return None
    print(f"  Bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Step 4: Poll until COMPLETED ─────────────────────────────

def poll_status(interval: int = 10) -> str | None:
    query = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"
    while True:
        body = gql(API_URL, HEADERS, query)
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


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Bulk create Shopify collections via Bulk Operation API"
    )
    parser.add_argument(
        "--csv", required=True,
        help="CSV or Excel file with 'Title' + optional: Handle, Page Title, Meta Description, Condition",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Build JSONL only — do not upload or run mutation",
    )
    args = parser.parse_args()

    if os.path.exists(args.csv):
        csv_path = args.csv
    else:
        csv_path = os.path.join(os.path.dirname(BASE_DIR), args.csv)

    print(f"Reading : {csv_path}")
    df = _read_df(csv_path)
    print(f"Columns : {df.columns.tolist()}")
    print(f"Rows    : {len(df)}")

    out_jsonl = os.path.join(OUTPUT_DIR, "collections_create.jsonl")
    count = build_jsonl(df, out_jsonl)

    if args.dry_run:
        print("[DRY RUN] JSONL built — no changes sent to Shopify.")
        return
    if count == 0:
        print("[INFO] Nothing to create.")
        return

    print("\n── 1. Uploading JSONL ──")
    target = create_staged_upload("collections_create.jsonl")
    if not target:
        sys.exit(1)
    res_url = upload_jsonl(target, out_jsonl)

    print("\n── 2. Running bulk mutation ──")
    op = run_bulk_mutation(res_url)
    if not op:
        sys.exit(1)

    print("\n── 3. Polling status ──")
    result_url = poll_status()
    print(f"\n✅ Done!  Result URL: {result_url}")


if __name__ == "__main__":
    main()
