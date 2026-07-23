"""
Update Shopify menus and Thai translations from a flat CSV/Excel.

Required CSV columns:
  - Menu GID     : The GraphQL ID of the menu to update (e.g. gid://shopify/Menu/123)
  - Menu Title   : Name of the menu (e.g. "Cooking Equipment")
  - Menu Handle  : URL handle   (e.g. "cooking-equipment")
  - Level        : 1 = Main item, 2 = Sub item, 3 = Sub-sub item
  - Main Category: Title of the Level-1 parent item
  - Item Title   : Title of this item
  - Item URL     : URL of this item (e.g. /collections/cooking-equipment)

Optional Columns:
  - Sub Category  : Title of the Level-2 parent (only needed for Level 3 items)
  - Item Title TH : Thai translation for this menu item (e.g. "อุปกรณ์ประกอบอาหาร")
  - Menu Title TH : Thai translation for the menu name itself (e.g. "อุปกรณ์ทำอาหาร")

Usage:
  python update_menus.py --csv ../bulk_product/data/menu_update.csv
  python update_menus.py --csv ../bulk_product/data/menu_update.csv --locale th
  python update_menus.py --csv ../bulk_product/data/menu_update.csv --dry-run
"""
import sys
import os
import json
import argparse
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL, get_val
from create_menus import build_items

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
REQUIRED_COLS = ["Menu GID", "Menu Title", "Menu Handle", "Level", "Main Category", "Item Title", "Item URL"]

# GraphQL Mutation to update menu and return item IDs for translation
UPDATE_MENU_MUTATION = """
mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu {
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
    userErrors { field message }
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


def register_translation(resource_id: str, value_th: str, locale: str = "th", key: str = "title") -> bool:
    """Register translation for a Shopify resource (Menu or Link)."""
    if not resource_id or not value_th:
        return False

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


def get_thai_title_col(df: pd.DataFrame, possible_cols: list[str]) -> str | None:
    """Find column matching any of the possible Thai title headers."""
    for col in df.columns:
        if col.strip().lower() in [c.lower() for c in possible_cols]:
            return col
    return None


def register_menu_item_translations(menu_node: dict, group: pd.DataFrame, locale: str = "th"):
    """Match returned menu items with CSV rows and register Thai translations."""
    thai_item_col = get_thai_title_col(group, ["Item Title TH", "Title TH", "Item Title (TH)", "Thai Title"])
    thai_menu_col = get_thai_title_col(group, ["Menu Title TH", "Menu Title (TH)", "Menu Title Thai"])

    # 1. Menu itself translation
    menu_gid = menu_node.get("id")
    if thai_menu_col and menu_gid:
        first_row = group.iloc[0]
        if menu_title_th := (get_val(first_row, thai_menu_col) or "").strip():
            print(f"   🈴 Registering Menu Title ({locale.upper()}): '{menu_title_th}'")
            if register_translation(menu_gid, menu_title_th, locale=locale, key="title"):
                print(f"      ✅ Menu title translation registered!")

    if not thai_item_col:
        print(f"   ℹ️  No Thai item title column ('Item Title TH') found in CSV. Skipping item translations.")
        return

    # Map CSV rows by (level, item_title) or (main_cat, sub_cat, item_title)
    # Build a lookup map from CSV group: (level, item_title.strip().lower()) -> title_th
    translation_map = {}
    for _, row in group.iterrows():
        title_th = (get_val(row, thai_item_col) or "").strip()
        level = str(get_val(row, "Level") or "").strip()
        item_title = (get_val(row, "Item Title") or "").strip()

        if not item_title:
            if level == "1":
                item_title = (get_val(row, "Main Category") or "").strip()
            elif level == "2":
                item_title = (get_val(row, "Sub Category") or "").strip()

        if item_title and title_th:
            key = (level, item_title.lower())
            translation_map[key] = title_th

    if not translation_map:
        print(f"   ℹ️  No Thai translations found in rows for this menu.")
        return

    print(f"   🈴 Registering MenuItem translations ({len(translation_map)} translation(s))...")
    registered_count = 0

    # Process level 1, 2, 3 items returned by Shopify
    for item_l1 in menu_node.get("items", []):
        l1_title = (item_l1.get("title") or "").strip()
        l1_id = item_l1.get("id", "")
        
        # Level 1 item translation
        if title_th := translation_map.get(("1", l1_title.lower())):
            link_id = l1_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/")
            if register_translation(link_id, title_th, locale=locale, key="title"):
                registered_count += 1
                print(f"      ✅ L1 '{l1_title}' → '{title_th}'")

        for item_l2 in item_l1.get("items", []):
            l2_title = (item_l2.get("title") or "").strip()
            l2_id = item_l2.get("id", "")

            # Level 2 item translation
            if title_th := translation_map.get(("2", l2_title.lower())):
                link_id = l2_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/")
                if register_translation(link_id, title_th, locale=locale, key="title"):
                    registered_count += 1
                    print(f"      ✅ L2 '{l2_title}' → '{title_th}'")

            for item_l3 in item_l2.get("items", []):
                l3_title = (item_l3.get("title") or "").strip()
                l3_id = item_l3.get("id", "")

                # Level 3 item translation
                if title_th := translation_map.get(("3", l3_title.lower())):
                    link_id = l3_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/")
                    if register_translation(link_id, title_th, locale=locale, key="title"):
                        registered_count += 1
                        print(f"      ✅ L3 '{l3_title}' → '{title_th}'")

    print(f"   🎉 Registered {registered_count} item translation(s) successfully.")


def main():
    parser = argparse.ArgumentParser(description="Update Shopify menus and Thai translations from flat CSV/Excel")
    parser.add_argument("--csv", required=True, help="Path to flat CSV/Excel file")
    parser.add_argument("--locale", default="th", help="Target locale for translations (default: th)")
    parser.add_argument("--dry-run", action="store_true", help="Preview only — do not call API")
    args = parser.parse_args()

    csv_path = os.path.abspath(args.csv)
    print(f"Reading : {csv_path}")
    if not os.path.exists(csv_path):
        print(f"[ERR] File not found: {csv_path}")
        return

    ext = os.path.splitext(csv_path)[1].lower()
    if ext in (".xlsx", ".xls"):
        df = pd.read_excel(csv_path, dtype=str).fillna("")
    else:
        df = pd.read_csv(csv_path, dtype=str).fillna("")

    # Drop unnamed columns
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]

    for col in REQUIRED_COLS:
        if col not in df.columns:
            print(f"[ERR] Missing required column: '{col}'")
            return

    # Check if Thai translations exist in CSV
    has_thai_col = any(c.lower() in [col.lower() for col in df.columns] for c in ["Item Title TH", "Title TH", "Item Title (TH)", "Thai Title"])
    if has_thai_col:
        print("🈴 Thai translation column detected in CSV!")

    # Group by Menu GID (one API call per menu)
    grouped = df.groupby(["Menu GID", "Menu Title", "Menu Handle"], sort=False)
    print(f"Found {len(grouped)} menu(s) to update.\n")

    for (menu_gid, menu_title, menu_handle), group in grouped:
        if not menu_gid:
            continue

        items = build_items(group)
        print(f"── Menu: {menu_title} ({menu_handle}) -> {menu_gid}")
        print(f"   Items: {len(items)} top-level item(s)")

        if args.dry_run:
            print(f"   [DRY RUN] Payload:\n{json.dumps(items, indent=4, ensure_ascii=False)}\n")
            continue

        # 1. Update Menu Items
        res = gql(API_URL, HEADERS, UPDATE_MENU_MUTATION, {
            "id": menu_gid, "title": menu_title, "handle": menu_handle, "items": items
        })
        data = (res or {}).get("data", {}).get("menuUpdate", {})
        errs = data.get("userErrors", [])
        menu_node = data.get("menu")

        if errs:
            print(f"   [ERR] Menu Update Error: {errs}\n")
            continue
        elif menu_node:
            print(f"   [OK]  Updated Menu Structure: {menu_node.get('title')} → {menu_node.get('id')}")
            # 2. Register Thai Translations for Menu Items & Menu Title
            register_menu_item_translations(menu_node, group, locale=args.locale)
            print()
        else:
            print(f"   [WARN] Unexpected response: {data}\n")


if __name__ == "__main__":
    main()
