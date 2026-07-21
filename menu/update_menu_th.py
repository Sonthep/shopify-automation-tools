"""
Update Thai translations for Shopify menus and menu items from a CSV or Excel file.

This script updates ONLY the Thai translations (using Shopify GraphQL Translations API)
without modifying or re-creating the English menu structure.

Supported CSV / Excel columns:
  - Menu GID (or Menu Title / Menu Handle) : Identifies the target menu
  - Item Title                             : Original English menu item title (for matching)
  - Item Title TH                          : Thai translation for the item title
  - Menu Title TH                          : (Optional) Thai translation for the menu title itself
  - Level                                  : (Optional) 1 = Main, 2 = Sub, 3 = Sub-sub item

Usage:
  python update_menu_th.py --csv output/menus_export.csv --dry-run
  python update_menu_th.py --csv output/menus_export.csv
  python update_menu_th.py --csv output/menus_export.csv --locale th
"""

import sys
import os
import argparse
import pandas as pd

# Add parent directory to path to import utils
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL, get_val

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# GraphQL Queries & Mutations
QUERY_MENUS = """
query {
  menus(first: 250) {
    edges {
      node {
        id
        title
        handle
        items {
          id
          title
          url
          items {
            id
            title
            url
            items {
              id
              title
              url
            }
          }
        }
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


def get_translatable_digest(resource_id: str, key: str = "title") -> str | None:
    """Fetch translation digest for a Shopify resource (Menu or Link)."""
    body = gql(API_URL, HEADERS, QUERY_TRANSLATABLE_DIGEST, {"resourceId": resource_id})
    if not body:
        return None
    resource = body.get("data", {}).get("translatableResource")
    if not resource:
        return None
    for entry in resource.get("translatableContent", []):
        if entry.get("key") == key:
            return entry.get("digest")
    return None


def register_translation(resource_id: str, value_th: str, locale: str = "th", key: str = "title", dry_run: bool = False) -> bool:
    """Register translation for a Shopify resource (Menu or Link)."""
    if not resource_id or not value_th:
        return False

    if dry_run:
        print(f"      [DRY RUN] Would register: {resource_id} ({key}) -> '{value_th}' ({locale})")
        return True

    digest = get_translatable_digest(resource_id, key=key)
    if not digest:
        print(f"      ⚠️ No digest found for {resource_id} (key: {key})")
        return False

    res = gql(API_URL, HEADERS, MUTATION_REGISTER_TRANSLATION, {
        "resourceId": resource_id,
        "translations": [{
            "key": key,
            "value": value_th,
            "locale": locale,
            "translatableContentDigest": digest
        }]
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


def main():
    parser = argparse.ArgumentParser(description="Update Thai menu translations on Shopify")
    parser.add_argument("--csv", help="Path to CSV or Excel file containing Thai translations")
    parser.add_argument("--locale", default="th", help="Target locale code (default: th)")
    parser.add_argument("--dry-run", action="store_true", help="Preview matches without applying API changes")
    args = parser.parse_args()

    # Determine input CSV/Excel path
    csv_path = args.csv
    if not csv_path:
        default_csv = os.path.join(os.path.dirname(__file__), "output", "menus_export.csv")
        if os.path.exists(default_csv):
            csv_path = default_csv
        else:
            print("[ERR] Please specify input file using --csv <filepath>")
            return

    csv_path = os.path.abspath(csv_path)
    print(f"📄 Reading file: {csv_path}")
    if not os.path.exists(csv_path):
        print(f"❌ File not found: {csv_path}")
        return

    ext = os.path.splitext(csv_path)[1].lower()
    if ext in (".xlsx", ".xls"):
        df = pd.read_excel(csv_path, dtype=str).fillna("")
    else:
        # Try multiple encodings for Windows compatibility (utf-8-sig, utf-8, cp874)
        for enc in ["utf-8-sig", "utf-8", "cp874", "tis-620"]:
            try:
                df = pd.read_csv(csv_path, dtype=str, encoding=enc).fillna("")
                break
            except (UnicodeDecodeError, Exception):
                continue

    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]

    # Detect relevant columns
    gid_col = get_col_name(df, ["Menu GID", "Menu ID", "GID"])
    menu_title_col = get_col_name(df, ["Menu Title", "Menu Name"])
    menu_handle_col = get_col_name(df, ["Menu Handle", "Handle"])
    item_title_col = get_col_name(df, ["Item Title", "Title", "Main Category"])
    item_th_col = get_col_name(df, ["Item Title TH", "Title TH", "Item Title (TH)", "Thai Title", "Item Title Thai"])
    menu_th_col = get_col_name(df, ["Menu Title TH", "Menu Title (TH)", "Menu Title Thai"])

    if not item_th_col:
        print("❌ Could not find a Thai title column (e.g. 'Item Title TH' or 'Title TH') in the file.")
        print(f"Available columns: {df.columns.tolist()}")
        return

    print(f"🔍 Column mapping:")
    print(f"   - English Item Title Column: {item_title_col}")
    print(f"   - Thai Item Title Column   : {item_th_col}")
    if menu_th_col:
        print(f"   - Thai Menu Title Column   : {menu_th_col}")
    print()

    # Build translation lookups from CSV
    # Key formats:
    # 1. (menu_identifier, level, item_title.lower()) -> title_th
    # 2. (menu_identifier, item_title.lower()) -> title_th
    translation_map = {}
    menu_title_th_map = {}

    for _, row in df.iterrows():
        menu_gid = (get_val(row, gid_col) or "").strip() if gid_col else ""
        menu_title = (get_val(row, menu_title_col) or "").strip() if menu_title_col else ""
        menu_handle = (get_val(row, menu_handle_col) or "").strip() if menu_handle_col else ""
        level = str(get_val(row, "Level") or "").strip()
        item_title = (get_val(row, item_title_col) or "").strip() if item_title_col else ""
        item_th = (get_val(row, item_th_col) or "").strip()
        menu_th = (get_val(row, menu_th_col) or "").strip() if menu_th_col else ""

        menu_key = menu_gid or menu_handle or menu_title

        if menu_key and menu_th:
            menu_title_th_map[menu_key] = menu_th
            menu_title_th_map[menu_key.lower()] = menu_th

        if item_title and item_th:
            if level:
                translation_map[(menu_key.lower(), level, item_title.lower())] = item_th
            translation_map[(menu_key.lower(), item_title.lower())] = item_th
            translation_map[(item_title.lower())] = item_th

    # Fetch existing menus from Shopify
    print("📡 Fetching menus from Shopify...")
    res = gql(API_URL, HEADERS, QUERY_MENUS)
    if not res:
        print("❌ Failed to fetch menus from Shopify.")
        return

    edges = res.get("data", {}).get("menus", {}).get("edges", [])
    print(f"Found {len(edges)} menu(s) in Shopify.\n")

    total_registered = 0

    for edge in edges:
        node = edge["node"]
        m_id = node["id"]
        m_title = node["title"]
        m_handle = node["handle"]

        print(f"── 📋 Menu: {m_title} ({m_handle}) -> {m_id}")

        # 1. Update Menu Title TH if available
        menu_th_val = (
            menu_title_th_map.get(m_id) or 
            menu_title_th_map.get(m_handle) or 
            menu_title_th_map.get(m_title) or 
            menu_title_th_map.get(m_handle.lower()) or 
            menu_title_th_map.get(m_title.lower())
        )
        if menu_th_val:
            print(f"   🈴 Registering Menu Title translation ({args.locale.upper()}): '{menu_th_val}'")
            if register_translation(m_id, menu_th_val, locale=args.locale, key="title", dry_run=args.dry_run):
                total_registered += 1
                print("      ✅ Menu Title translation saved!")

        # 2. Update Menu Items TH
        items_l1 = node.get("items", [])
        registered_items = 0

        for item_l1 in items_l1:
            l1_id = item_l1.get("id", "")
            l1_title = (item_l1.get("title") or "").strip()
            l1_link_id = l1_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/")

            l1_th = (
                translation_map.get((m_id.lower(), "1", l1_title.lower())) or
                translation_map.get((m_handle.lower(), "1", l1_title.lower())) or
                translation_map.get((m_title.lower(), "1", l1_title.lower())) or
                translation_map.get((m_handle.lower(), l1_title.lower())) or
                translation_map.get((m_title.lower(), l1_title.lower())) or
                translation_map.get(l1_title.lower())
            )

            if l1_th and l1_link_id:
                if register_translation(l1_link_id, l1_th, locale=args.locale, key="title", dry_run=args.dry_run):
                    registered_items += 1
                    print(f"      ✅ L1 '{l1_title}' → '{l1_th}'")

            for item_l2 in item_l1.get("items", []):
                l2_id = item_l2.get("id", "")
                l2_title = (item_l2.get("title") or "").strip()
                l2_link_id = l2_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/")

                l2_th = (
                    translation_map.get((m_id.lower(), "2", l2_title.lower())) or
                    translation_map.get((m_handle.lower(), "2", l2_title.lower())) or
                    translation_map.get((m_title.lower(), "2", l2_title.lower())) or
                    translation_map.get((m_handle.lower(), l2_title.lower())) or
                    translation_map.get((m_title.lower(), l2_title.lower())) or
                    translation_map.get(l2_title.lower())
                )

                if l2_th and l2_link_id:
                    if register_translation(l2_link_id, l2_th, locale=args.locale, key="title", dry_run=args.dry_run):
                        registered_items += 1
                        print(f"         ✅ L2 '{l2_title}' → '{l2_th}'")

                for item_l3 in item_l2.get("items", []):
                    l3_id = item_l3.get("id", "")
                    l3_title = (item_l3.get("title") or "").strip()
                    l3_link_id = l3_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/")

                    l3_th = (
                        translation_map.get((m_id.lower(), "3", l3_title.lower())) or
                        translation_map.get((m_handle.lower(), "3", l3_title.lower())) or
                        translation_map.get((m_title.lower(), "3", l3_title.lower())) or
                        translation_map.get((m_handle.lower(), l3_title.lower())) or
                        translation_map.get((m_title.lower(), l3_title.lower())) or
                        translation_map.get(l3_title.lower())
                    )

                    if l3_th and l3_link_id:
                        if register_translation(l3_link_id, l3_th, locale=args.locale, key="title", dry_run=args.dry_run):
                            registered_items += 1
                            print(f"            ✅ L3 '{l3_title}' → '{l3_th}'")

        total_registered += registered_items
        print(f"   🎉 Registered {registered_items} item translation(s) for this menu.\n")

    mode_str = "[DRY RUN] Would register" if args.dry_run else "Successfully registered"
    print(f"✨ Finished! {mode_str} {total_registered} total translation(s).")


if __name__ == "__main__":
    main()
