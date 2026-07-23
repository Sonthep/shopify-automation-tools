"""
Update Thai translations for Shopify Collections from CSV or Excel file.

This script updates ONLY the Thai translations (using Shopify GraphQL Translations API)
without altering the English collection content or rules.

Supported CSV / Excel columns:
  - Collection GID / GID / Collection ID   : Shopify Collection GID (e.g. gid://shopify/Collection/123)
  - Title / Collection Title                : Original English title (for matching if GID is absent)
  - Handle / Collection Handle              : Collection handle (for matching if GID is absent)
  - Title TH / Collection Title TH          : Thai translation of Collection Title
  - Description TH / Body TH                : (Optional) Thai translation of Description
  - Meta title th / Page Title TH / SEO Title TH: (Optional) Thai translation of SEO Meta Title
  - Meta description th / Meta Description TH : (Optional) Thai translation of SEO Meta Description

Usage:
  python update_collection_th.py --csv ../data/collections_update_th.xlsx --dry-run
  python update_collection_th.py --csv ../data/collections_update_th.xlsx
  python update_collection_th.py --csv ../data/collections_update_th.csv --locale th
"""

import sys
import os
import argparse
import pandas as pd

# Add parent directory to path to import utils
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from utils import make_headers, gql, API_URL, get_val

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# GraphQL Queries & Mutations
QUERY_ALL_COLLECTIONS = """
query {
  collections(first: 250) {
    edges {
      node {
        id
        title
        handle
      }
    }
  }
}
"""

QUERY_TRANSLATABLE_DIGEST = """
query translatableResource($resourceId: ID!) {
  translatableResource(resourceId: $resourceId) {
    translatableContent { key digest }
  }
}
"""

MUTATION_REGISTER_TRANSLATION = """
mutation translationRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { key locale value }
    userErrors { field message }
  }
}
"""


def get_translatable_digests(resource_id: str) -> dict[str, str]:
    """Fetch all available translatable key -> digest map for a Collection resource."""
    body = gql(API_URL, HEADERS, QUERY_TRANSLATABLE_DIGEST, {"resourceId": resource_id})
    if not body:
        return {}
    resource = body.get("data", {}).get("translatableResource")
    if not resource:
        return {}
    digest_map = {}
    for entry in resource.get("translatableContent", []):
        key = entry.get("key")
        digest = entry.get("digest")
        if key and digest:
            digest_map[key] = digest
    return digest_map


def register_collection_translations(
    resource_id: str,
    translations_to_save: dict[str, str],
    locale: str = "th",
    dry_run: bool = False
) -> bool:
    """Register multiple translation keys (title, body_html, meta_title, meta_description) for a Collection."""
    if not resource_id or not translations_to_save:
        return False

    if dry_run:
        for k, v in translations_to_save.items():
            print(f"      [DRY RUN] Would register: {resource_id} ({k}) -> '{v}' ({locale})")
        return True

    digest_map = get_translatable_digests(resource_id)
    if not digest_map:
        print(f"      ⚠️ No translatable digests found for collection: {resource_id}")
        return False

    translation_inputs = []
    for key, val in translations_to_save.items():
        digest = digest_map.get(key)
        if digest:
            translation_inputs.append({
                "key": key,
                "value": val,
                "locale": locale,
                "translatableContentDigest": digest
            })
        else:
            print(f"      ⚠️ No digest found for key '{key}' on {resource_id}")

    if not translation_inputs:
        return False

    res = gql(API_URL, HEADERS, MUTATION_REGISTER_TRANSLATION, {
        "resourceId": resource_id,
        "translations": translation_inputs
    })

    data = (res or {}).get("data", {}).get("translationsRegister", {})
    errs = data.get("userErrors", [])
    if errs:
        print(f"      ❌ Translation error for {resource_id}: {errs}")
        return False
    return True


def get_col_name(df: pd.DataFrame, possible_cols: list[str]) -> str | None:
    """Find actual column name matching any of the possible names in order of preference."""
    df_cols_lower = {col.strip().lower(): col for col in df.columns}
    for p in possible_cols:
        if p.strip().lower() in df_cols_lower:
            return df_cols_lower[p.strip().lower()]
    return None


def read_input_file(csv_path: str) -> pd.DataFrame:
    """Read CSV or Excel file with encoding fallbacks for Windows compatibility."""
    ext = os.path.splitext(csv_path)[1].lower()
    if ext in (".xlsx", ".xls"):
        df = pd.read_excel(csv_path, dtype=str).fillna("")
    else:
        df = None
        for enc in ["utf-8-sig", "utf-8", "cp874", "tis-620"]:
            try:
                df = pd.read_csv(csv_path, dtype=str, encoding=enc).fillna("")
                break
            except Exception:
                continue
        if df is None:
            df = pd.read_csv(csv_path, dtype=str).fillna("")

    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
    return df


def main():
    parser = argparse.ArgumentParser(description="Update Thai translations for Shopify collections")
    parser.add_argument("--csv", help="Path to CSV or Excel file containing Thai collection translations")
    parser.add_argument("--locale", default="th", help="Target locale code (default: th)")
    parser.add_argument("--dry-run", action="store_true", help="Preview matches without calling API")
    args = parser.parse_args()

    input_path = args.csv
    if not input_path:
        # Default fallback paths
        default_paths = [
            os.path.join(os.path.dirname(__file__), "output", "collections_export.xlsx"),
            os.path.join(os.path.dirname(__file__), "..", "data", "collections_export.xlsx"),
            os.path.join(os.path.dirname(__file__), "..", "data", "update_collection_th.csv"),
        ]
        for p in default_paths:
            if os.path.exists(p):
                input_path = p
                break

    if not input_path or not os.path.exists(input_path):
        print("[ERR] Please specify input file using --csv <filepath>")
        return

    input_path = os.path.abspath(input_path)
    print(f"📄 Reading file: {input_path}")
    df = read_input_file(input_path)

    # Detect relevant columns
    gid_col = get_col_name(df, ["Collection GID", "GID", "Collection ID", "ID"])
    title_col = get_col_name(df, ["Title", "Collection Title", "Collection Name"])
    handle_col = get_col_name(df, ["Handle", "Collection Handle"])

    title_th_col = get_col_name(df, [
        "Title TH", "Collection Title TH", "Title (TH)", "Thai Title",
        "Collection Title Thai", "Title Thai"
    ])
    desc_th_col = get_col_name(df, [
        "Description TH", "Body TH", "Description (TH)", "Thai Description",
        "Collection Description TH", "Body HTML TH", "Description Thai"
    ])
    page_title_th_col = get_col_name(df, [
        "Meta title th", "Meta Title TH", "Meta Title (TH)", "Meta Title Thai", "Meta Title",
        "Page Title TH", "SEO Title TH", "Page Title (TH)", "Thai Page Title", "Page Title Thai"
    ])
    meta_desc_th_col = get_col_name(df, [
        "Meta description th", "Meta Description TH", "Meta Description (TH)", "Thai Meta Description",
        "Meta Description Thai", "SEO Description TH", "Page Description TH", "SEO Description (TH)"
    ])
    if not meta_desc_th_col and desc_th_col:
        meta_desc_th_col = desc_th_col

    if not title_th_col and not desc_th_col and not page_title_th_col and not meta_desc_th_col:
        print("❌ Could not find any Thai translation column (e.g. 'Title TH', 'Collection Title TH', 'Description TH').")
        print(f"Available columns: {df.columns.tolist()}")
        return

    print("🔍 Column mapping:")
    if gid_col:
        print(f"   - Collection GID Column   : {gid_col}")
    if title_col:
        print(f"   - English Title Column    : {title_col}")
    if handle_col:
        print(f"   - Collection Handle Column: {handle_col}")
    if title_th_col:
        print(f"   - Thai Title Column       : {title_th_col}")
    if desc_th_col:
        print(f"   - Thai Description Column : {desc_th_col}")
    if page_title_th_col:
        print(f"   - Thai Page Title Column  : {page_title_th_col}")
    if meta_desc_th_col:
        print(f"   - Thai Meta Desc Column   : {meta_desc_th_col}")
    print()

    # Pre-fetch all collections from Shopify if GID matching or resolution is needed
    print("📡 Fetching collections from Shopify...")
    res = gql(API_URL, HEADERS, QUERY_ALL_COLLECTIONS)
    shopify_collections = {}
    if res:
        edges = res.get("data", {}).get("collections", {}).get("edges", [])
        for edge in edges:
            node = edge["node"]
            c_id = node.get("id")
            c_handle = (node.get("handle") or "").strip().lower()
            c_title = (node.get("title") or "").strip().lower()
            if c_id:
                shopify_collections[c_id] = node
                if c_handle:
                    shopify_collections[c_handle] = node
                if c_title:
                    shopify_collections[c_title] = node
        print(f"Loaded {len(edges)} collection(s) from Shopify.\n")

    updated_count = 0

    for idx, row in df.iterrows():
        col_gid = (get_val(row, gid_col) or "").strip() if gid_col else ""
        title = (get_val(row, title_col) or "").strip() if title_col else ""
        handle = (get_val(row, handle_col) or "").strip() if handle_col else ""

        title_th = (get_val(row, title_th_col) or "").strip() if title_th_col else ""
        desc_th = (get_val(row, desc_th_col) or "").strip() if desc_th_col else ""
        page_title_th = (get_val(row, page_title_th_col) or "").strip() if page_title_th_col else ""
        meta_desc_th = (get_val(row, meta_desc_th_col) or "").strip() if meta_desc_th_col else ""

        # Target translations dictionary
        translations = {}
        if title_th:
            translations["title"] = title_th
        if desc_th:
            translations["body_html"] = desc_th
        if page_title_th:
            translations["meta_title"] = page_title_th
        if meta_desc_th:
            translations["meta_description"] = meta_desc_th

        if not translations:
            continue

        # Resolve Collection GID if missing
        matched_node = None
        if col_gid and col_gid.startswith("gid://shopify/Collection/"):
            matched_gid = col_gid
            matched_node = shopify_collections.get(col_gid)
        else:
            matched_node = (
                shopify_collections.get(col_gid) or
                shopify_collections.get(handle.lower()) or
                shopify_collections.get(title.lower())
            )
            matched_gid = matched_node.get("id") if matched_node else None

        if not matched_gid:
            print(f"⚠️ [Row {idx+1}] Could not find Collection GID for: GID='{col_gid}', Handle='{handle}', Title='{title}'. Skipping.")
            continue

        display_name = matched_node.get("title") if matched_node else (title or handle or matched_gid)
        print(f"── 📦 Collection: {display_name} -> {matched_gid}")
        for k, v in translations.items():
            print(f"   🈴 [{k}] -> '{v}'")

        if register_collection_translations(matched_gid, translations, locale=args.locale, dry_run=args.dry_run):
            updated_count += 1
            print("      ✅ Translation saved successfully!\n")

    mode_str = "[DRY RUN] Would update" if args.dry_run else "Successfully updated"
    print(f"✨ Finished! {mode_str} {updated_count} collection(s).")


if __name__ == "__main__":
    main()
