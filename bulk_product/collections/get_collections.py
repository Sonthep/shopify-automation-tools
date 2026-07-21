"""
Export ALL Shopify collections to Excel via Bulk Operation API.

Fetches per collection:
  - Collection GID   (for update)
  - Title
  - Handle           (URL handle)
  - SEO Page Title   (seo.title)
  - Meta Description (seo.description)
  - Rule Condition   (ruleSet condition — smart collections only)
  - Collection Type  (SMART / CUSTOM)

Usage:
    py get_collections.py
    py get_collections.py --out output/collections.xlsx
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import json
import os
import time

import pandas as pd
import requests

from utils import make_headers, gql, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

QUERY_THAI_TRANSLATION = """
query getCollectionTranslations($resourceId: ID!) {
  translatableResource(resourceId: $resourceId) {
    translations(locale: "th") {
      key
      value
    }
  }
}
"""


def fetch_thai_translations(resource_id: str) -> dict[str, str]:
    """Fetch existing Thai translations (title, body_html, meta_title, meta_description) for a collection."""
    res = gql(API_URL, HEADERS, QUERY_THAI_TRANSLATION, {"resourceId": resource_id})
    translations = (res or {}).get("data", {}).get("translatableResource", {}).get("translations", [])
    return {t.get("key"): t.get("value") for t in translations if t.get("key") and t.get("value")}

# ── Step 1: Start bulk query ──────────────────────────────────

INNER_QUERY = """
{
  collections {
    edges {
      node {
        id
        title
        handle
        seo {
          title
          description
        }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
        resourcePublicationsV2(first: 10) {
          edges {
            node {
              isPublished
              publication {
                id
                name
              }
            }
          }
        }
      }
    }
  }
}
"""

BULK_MUTATION = """
mutation {
  bulkOperationRunQuery(
    query: $query
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
"""


# ── Step 2: Run bulk query ────────────────────────────────────

def start_bulk_query() -> str | None:
    mutation = """
    mutation RunBulkQuery($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }"""
    body = gql(API_URL, HEADERS, mutation, {"query": INNER_QUERY})
    if not body:
        return None
    op = body["data"]["bulkOperationRunQuery"]
    if op["userErrors"]:
        print(f"[ERR] bulkOperationRunQuery: {op['userErrors']}")
        return None
    bulk_id = op["bulkOperation"]["id"]
    print(f"  Bulk query started: {bulk_id}")
    return bulk_id


# ── Step 3: Poll until COMPLETED ─────────────────────────────

def poll_bulk_query(interval: int = 5) -> str | None:
    query = "{ currentBulkOperation(type: QUERY) { id status errorCode objectCount url } }"
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
            print(f"[ERR] Bulk query failed: {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Step 4: Download & parse JSONL ───────────────────────────

def download_jsonl(url: str) -> list[dict]:
    print(f"  Downloading: {url}")
    res = requests.get(url, timeout=120)
    res.raise_for_status()
    rows = []
    for line in res.text.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    print(f"  {len(rows)} raw rows downloaded")
    return rows


# ── Step 5: Parse rows → DataFrame ───────────────────────────

def parse_rows(rows: list[dict], fetch_trans: bool = False) -> pd.DataFrame:
    collection_pubs = {}
    collections = []

    for obj in rows:
        if "__parentId" in obj:
            parent_id = obj["__parentId"]
            if "publication" in obj and obj.get("isPublished") is True:
                pub_name = obj["publication"].get("name")
                if pub_name:
                    if parent_id not in collection_pubs:
                        collection_pubs[parent_id] = []
                    collection_pubs[parent_id].append(pub_name)
        else:
            collections.append(obj)

    records = []
    total_col = len(collections)
    for idx, obj in enumerate(collections, start=1):
        col_id    = obj.get("id", "")
        title     = obj.get("title", "")
        handle    = obj.get("handle", "")
        seo       = obj.get("seo") or {}
        rule_set  = obj.get("ruleSet")

        page_title   = seo.get("title", "")
        meta_desc    = seo.get("description", "")

        # Determine type and condition string
        if rule_set:
            col_type   = "SMART"
            rules      = rule_set.get("rules") or []
            join_word  = "OR" if rule_set.get("appliedDisjunctively") else "AND"
            conditions = [
                f"{r.get('column')} {r.get('relation')} {r.get('condition')}"
                for r in rules
            ]
            condition = f" {join_word} ".join(conditions)
        else:
            col_type  = "CUSTOM"
            condition = ""

        pubs = collection_pubs.get(col_id, [])
        pubs_str = ", ".join(sorted(pubs))

        rec = {
            "Collection GID":   col_id,
            "Title":            title,
            "Handle":           handle,
            "Page Title":       page_title,
            "Meta Description": meta_desc,
            "Type":             col_type,
            "Condition":        condition,
            "Publishing":       pubs_str,
        }

        if fetch_trans and col_id:
            print(f"  [{idx}/{total_col}] Fetching Thai translations for {title}...")
            trans_map = fetch_thai_translations(col_id)
            rec["Title TH"]            = trans_map.get("title", "")
            rec["Description TH"]      = trans_map.get("body_html", "")
            rec["Meta title th"]       = trans_map.get("meta_title", "")
            rec["Meta description th"] = trans_map.get("meta_description", "")

        records.append(rec)

    cols = [
        "Collection GID",
        "Title",
        "Handle",
        "Page Title",
        "Meta Description",
        "Type",
        "Condition",
        "Publishing",
    ]
    if fetch_trans:
        cols.extend(["Title TH", "Description TH", "Meta title th", "Meta description th"])

    df = pd.DataFrame(records, columns=cols)
    return df


# ── Step 6: Save Excel ────────────────────────────────────────

def save_excel(df: pd.DataFrame, out_path: str):
    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Collections")

        # Auto-fit column width
        ws = writer.sheets["Collections"]
        for col_cells in ws.columns:
            max_len = max(
                (len(str(cell.value)) if cell.value else 0 for cell in col_cells),
                default=10,
            )
            ws.column_dimensions[col_cells[0].column_letter].width = min(max_len + 4, 80)

    print(f"\n✅ Saved {len(df)} collections → {out_path}")


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Export Shopify collections (title, condition, GID, SEO, handle) to Excel"
    )
    parser.add_argument(
        "--out",
        default=os.path.join(BASE_DIR, "output", "collections_export.xlsx"),
        help="Output Excel file path (default: collections/output/collections_export.xlsx)",
    )
    parser.add_argument(
        "--fetch-translations",
        action="store_true",
        help="Fetch existing Thai translations (Title TH, Description TH, Meta title th, Meta description th)",
    )
    args = parser.parse_args()

    print("\n── 1. Starting bulk query ──")
    bulk_id = start_bulk_query()
    if not bulk_id:
        sys.exit(1)

    print("\n── 2. Polling status ──")
    result_url = poll_bulk_query()
    if not result_url:
        sys.exit(1)

    print("\n── 3. Downloading results ──")
    rows = download_jsonl(result_url)

    print("\n── 4. Parsing data ──")
    df = parse_rows(rows, fetch_trans=args.fetch_translations)
    print(f"  {len(df)} collections parsed")
    print(f"  Types: {df['Type'].value_counts().to_dict()}")

    print("\n── 5. Saving Excel ──")
    save_excel(df, args.out)


if __name__ == "__main__":
    main()
