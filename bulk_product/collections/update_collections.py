"""
Bulk update Shopify collections via Bulk Operation API.

Required CSV columns:
  - Collection GID   : Shopify collection GID (e.g. gid://shopify/Collection/123)

Optional CSV columns (leave blank to keep existing value):
  - Title
  - Handle
  - Page Title       : SEO page title (seo.title)
  - Meta Description : SEO meta description (seo.description)
  - Condition        : Rules for SMART collections (leave blank = no change)
      Format A — JSON array:
        [{"column":"TAG","relation":"EQUALS","condition":"shoes"}]
        Prefix with "OR|" for OR logic:
        OR|[{"column":"TAG","relation":"EQUALS","condition":"shoes"}]
      Format B — plain text (as exported by get_collections.py):
        TAG EQUALS shoes AND TAG EQUALS boots
        TAG EQUALS shoes OR TAG EQUALS boots

Usage:
    py update_collections.py --csv ../data/collections_export.xlsx
    py update_collections.py --csv ../data/collections_export.xlsx --dry-run
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

COL_GID       = "Collection GID"
COL_TITLE     = "Title"
COL_HANDLE    = "Handle"
COL_PAGE      = "Page Title"
COL_META      = "Meta Description"
COL_CONDITION = "Condition"
COL_PUBLISHING = "Publishing"

OUTPUT_DIR = os.path.join(BASE_DIR, "output")

BULK_MUTATION = (
    "mutation updCol($input: CollectionInput!) { "
    "collectionUpdate(input: $input) { "
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
    if COL_GID not in df.columns:
        print(f"[ERR] Column '{COL_GID}' is required.")
        sys.exit(1)

    count = skipped = 0
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(out_path, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            gid = get_val(row, COL_GID)
            if not gid:
                skipped += 1
                continue

            inp: dict = {"id": gid}

            if v := get_val(row, COL_TITLE):
                inp["title"] = v
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

            if len(inp) <= 1:
                skipped += 1
                continue

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
    mutation BulkUpdateCollections($stagedUploadPath: String!) {{
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


# ── Step 5: Update Publishing Status ──────────────────────────

def update_publishing(df: pd.DataFrame, dry_run: bool):
    if COL_PUBLISHING not in df.columns:
        return

    # Check if there's at least one non-empty value in Publishing
    has_publishing_updates = False
    for _, row in df.iterrows():
        if get_val(row, COL_PUBLISHING) is not None:
            has_publishing_updates = True
            break

    if not has_publishing_updates:
        return

    print("\n── 4. Updating Publishing channels ──")
    
    # Query all publications to map names to GIDs
    pub_query = """
    {
      publications(first: 50) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
    """
    res_pub = gql(API_URL, HEADERS, pub_query)
    publications = []
    if res_pub and "data" in res_pub:
        edges = res_pub["data"].get("publications", {}).get("edges", [])
        publications = [edge["node"] for edge in edges if "node" in edge]
    
    name_to_gid = {pub["name"].strip().lower(): pub["id"] for pub in publications}
    if not name_to_gid:
        print("  [WARN] No publications found in this shop.")
        return

    pub_mut = """
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }
    """

    unpub_mut = """
    mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
      publishableUnpublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }
    """

    for _, row in df.iterrows():
        gid = get_val(row, COL_GID)
        if not gid:
            continue
        
        pub_val = get_val(row, COL_PUBLISHING)
        if pub_val is None:
            continue # skip if blank (keep existing publishing)
            
        # Parse targets
        target_names = []
        if pub_val.strip().lower() != "none":
            target_names = [n.strip().lower() for n in pub_val.split(",") if n.strip()]
        
        to_publish_inputs = []
        to_unpublish_inputs = []
        
        for name, pub_id in name_to_gid.items():
            if name in target_names:
                to_publish_inputs.append({"publicationId": pub_id})
            else:
                to_unpublish_inputs.append({"publicationId": pub_id})
                
        col_title = get_val(row, COL_TITLE) or gid
        
        if dry_run:
            pub_names_str = ", ".join([pub["name"] for pub in publications if pub["id"] in [x["publicationId"] for x in to_publish_inputs]]) or "None"
            unpub_names_str = ", ".join([pub["name"] for pub in publications if pub["id"] in [x["publicationId"] for x in to_unpublish_inputs]]) or "None"
            print(f"  [DRY RUN] {col_title}:")
            print(f"    Publish to  : {pub_names_str}")
            print(f"    Unpublish from: {unpub_names_str}")
            continue

        # Run publish
        if to_publish_inputs:
            res = gql(API_URL, HEADERS, pub_mut, {"id": gid, "input": to_publish_inputs})
            errs = (res or {}).get("data", {}).get("publishablePublish", {}).get("userErrors", [])
            if errs:
                print(f"  [ERR] {col_title} publish errors: {errs}")
                
        # Run unpublish
        if to_unpublish_inputs:
            res = gql(API_URL, HEADERS, unpub_mut, {"id": gid, "input": to_unpublish_inputs})
            errs = (res or {}).get("data", {}).get("publishableUnpublish", {}).get("userErrors", [])
            if errs:
                print(f"  [ERR] {col_title} unpublish errors: {errs}")
                
        print(f"  [OK] Updated publishing for: {col_title}")


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Bulk update Shopify collections (title, handle, SEO, rules, publishing) via Bulk Operation API"
    )
    parser.add_argument(
        "--csv", required=True,
        help="CSV or Excel file with 'Collection GID' + optional: Title, Handle, Page Title, Meta Description, Condition, Publishing",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Dry run: Build JSONL and preview publishing updates without applying changes",
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

    out_jsonl = os.path.join(OUTPUT_DIR, "collections_update.jsonl")
    count = build_jsonl(df, out_jsonl)

    # 1. Run bulk metadata updates if any fields are present
    if count > 0:
        if args.dry_run:
            print("[DRY RUN] JSONL built — no metadata changes sent to Shopify.")
        else:
            print("\n── 1. Uploading JSONL ──")
            target = create_staged_upload("collections_update.jsonl")
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
    else:
        print("[INFO] No metadata updates (Title, Handle, SEO, rules) detected.")

    # 2. Run publishing updates (normal API calls)
    update_publishing(df, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
