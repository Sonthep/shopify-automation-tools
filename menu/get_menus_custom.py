"""
Get all Shopify menus and consolidate all item titles into a single clean column.
Outputs to both CSV (utf-8-sig) and Excel (.xlsx) formats.

Output columns:
  - Menu GID      : Shopify Menu GID (e.g. gid://shopify/Menu/123)
  - Menu Title    : Name of the navigation menu
  - Menu Title TH : Thai translation of the menu title (if available)
  - Menu Handle   : Handle of the menu
  - Item Title    : Title of the menu item (All levels combined in one column)
  - Item Title TH : Thai translation of the menu item (if available or blank for user entry)
  - Level         : 1 = Main item, 2 = Sub item, 3 = Sub-sub item
  - Item URL      : URL of the menu item

Usage:
  python get_menus_custom.py
  python get_menus_custom.py --fetch-translations
"""

import sys
import os
import argparse
import pandas as pd

# Add parent directory to path to import utils
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
OUT_DIR = os.path.join(os.path.dirname(__file__), "output")
OUT_CSV = os.path.join(OUT_DIR, "menus_custom.csv")
OUT_XLSX = os.path.join(OUT_DIR, "menus_custom.xlsx")

QUERY = """
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

QUERY_THAI_TRANSLATION = """
query getTranslation($resourceId: ID!) {
  translatableResource(resourceId: $resourceId) {
    translations(locale: "th") {
      key
      value
    }
  }
}
"""


def fetch_thai_translation(resource_id: str, key: str = "title") -> str:
    """Fetch Thai translation value for a given resourceId (Menu or Link)."""
    if not resource_id:
        return ""
    res = gql(API_URL, HEADERS, QUERY_THAI_TRANSLATION, {"resourceId": resource_id})
    translations = (res or {}).get("data", {}).get("translatableResource", {}).get("translations", [])
    for t in translations:
        if t.get("key") == key and t.get("value"):
            return t.get("value")
    return ""


def flatten_items_custom(menu_gid: str, menu_title: str, menu_handle: str, items: list, fetch_trans: bool = True) -> list:
    """Recursively flatten all menu items into clean individual rows."""
    rows = []
    menu_title_th = fetch_thai_translation(menu_gid, key="title") if fetch_trans else ""

    for item_l1 in items:
        l1_id = item_l1.get("id", "")
        l1_link_id = l1_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/") if l1_id else ""
        l1_title_th = fetch_thai_translation(l1_link_id, key="title") if (fetch_trans and l1_link_id) else ""

        # Level 1 — Main item
        rows.append({
            "Menu GID": menu_gid,
            "Menu Title": menu_title,
            "Menu Title TH": menu_title_th,
            "Menu Handle": menu_handle,
            "Item Title": item_l1.get("title", ""),
            "Item Title TH": l1_title_th,
            "Level": 1,
            "Item URL": item_l1.get("url", ""),
        })

        for item_l2 in item_l1.get("items", []):
            l2_id = item_l2.get("id", "")
            l2_link_id = l2_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/") if l2_id else ""
            l2_title_th = fetch_thai_translation(l2_link_id, key="title") if (fetch_trans and l2_link_id) else ""

            # Level 2 — Sub item
            rows.append({
                "Menu GID": menu_gid,
                "Menu Title": menu_title,
                "Menu Title TH": menu_title_th,
                "Menu Handle": menu_handle,
                "Item Title": item_l2.get("title", ""),
                "Item Title TH": l2_title_th,
                "Level": 2,
                "Item URL": item_l2.get("url", ""),
            })

            for item_l3 in item_l2.get("items", []):
                l3_id = item_l3.get("id", "")
                l3_link_id = l3_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/") if l3_id else ""
                l3_title_th = fetch_thai_translation(l3_link_id, key="title") if (fetch_trans and l3_link_id) else ""

                # Level 3 — Sub-sub item
                rows.append({
                    "Menu GID": menu_gid,
                    "Menu Title": menu_title,
                    "Menu Title TH": menu_title_th,
                    "Menu Handle": menu_handle,
                    "Item Title": item_l3.get("title", ""),
                    "Item Title TH": l3_title_th,
                    "Level": 3,
                    "Item URL": item_l3.get("url", ""),
                })
    return rows


def main():
    parser = argparse.ArgumentParser(description="Export all Shopify menus into a clean custom CSV/Excel format")
    parser.add_argument("--fetch-translations", action="store_true", default=True, help="Fetch existing Thai translations (default: True)")
    parser.add_argument("--no-translations", action="store_false", dest="fetch_translations", help="Skip fetching existing Thai translations")
    args = parser.parse_args()

    print("📡 Fetching all menus from Shopify...")
    res = gql(API_URL, HEADERS, QUERY)
    if not res:
        print("❌ No response from API.")
        return

    edges = res.get("data", {}).get("menus", {}).get("edges", [])
    print(f"Found {len(edges)} menu(s) in Shopify.\n")

    all_rows = []
    for edge in edges:
        node = edge["node"]
        rows = flatten_items_custom(
            menu_gid=node["id"],
            menu_title=node["title"],
            menu_handle=node["handle"],
            items=node.get("items", []),
            fetch_trans=args.fetch_translations
        )
        all_rows.extend(rows)
        print(f"  📋 [{node['title']}] -> {len(rows)} item(s)")

    if not all_rows:
        print("ℹ️ No menu items found.")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    cols = [
        "Menu GID", "Menu Title", "Menu Title TH", "Menu Handle",
        "Item Title", "Item Title TH", "Level", "Item URL"
    ]
    df = pd.DataFrame(all_rows, columns=cols)

    # Export CSV with UTF-8 BOM (utf-8-sig) for Excel compatibility
    df.to_csv(OUT_CSV, index=False, encoding="utf-8-sig")
    print(f"\n✅ Exported CSV   : {OUT_CSV}")

    # Export Excel Workbook (.xlsx)
    try:
        df.to_excel(OUT_XLSX, index=False)
        print(f"✅ Exported Excel : {OUT_XLSX}")
    except Exception as e:
        print(f"⚠️ Could not export .xlsx file (openpyxl might be missing): {e}")

    print(f"\n🎉 Total exported: {len(all_rows)} menu item(s).")


if __name__ == "__main__":
    main()
