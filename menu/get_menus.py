"""
Get Shopify menus and export to CSV/Excel (including Thai translations if available).

Output columns:
  - Menu GID        : Shopify Menu GID
  - Menu Title      : Name of the navigation menu
  - Menu Title TH   : Thai translation of the menu title (if available)
  - Menu Handle     : Handle of the navigation menu
  - Level           : 1 = Main item, 2 = Sub item, 3 = Sub-sub item
  - Main Category   : Title of the Level-1 parent item
  - Sub Category    : Title of the Level-2 parent item (if applicable)
  - Item Title      : Title of this menu item
  - Item Title TH   : Thai translation of this menu item (if available)
  - Item URL        : URL of this menu item

Usage:
    py get_menus.py
    py get_menus.py --fetch-translations
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL
import argparse
import pandas as pd

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
OUT_DIR  = os.path.join(os.path.dirname(__file__), "output")
OUT_FILE = os.path.join(OUT_DIR, "menus_export.csv")


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


def flatten_items(menu_gid: str, menu_title: str, menu_handle: str, items: list, fetch_trans: bool = False) -> list:
    """Recursively flatten menu items into individual rows."""
    rows = []
    menu_title_th = fetch_thai_translation(menu_gid, key="title") if fetch_trans else ""

    for item_l1 in items:
        l1_id = item_l1.get("id", "")
        l1_link_id = l1_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/") if l1_id else ""
        l1_title_th = fetch_thai_translation(l1_link_id, key="title") if (fetch_trans and l1_link_id) else ""

        # Level 1 — Main item
        rows.append({
            "Menu GID"     : menu_gid,
            "Menu Title"   : menu_title,
            "Menu Title TH": menu_title_th,
            "Menu Handle"  : menu_handle,
            "Level"        : 1,
            "Main Category": item_l1["title"],
            "Sub Category" : "",
            "Item Title"   : item_l1["title"],
            "Item Title TH": l1_title_th,
            "Item URL"     : item_l1.get("url", ""),
        })

        for item_l2 in item_l1.get("items", []):
            l2_id = item_l2.get("id", "")
            l2_link_id = l2_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/") if l2_id else ""
            l2_title_th = fetch_thai_translation(l2_link_id, key="title") if (fetch_trans and l2_link_id) else ""

            # Level 2 — Sub item
            rows.append({
                "Menu GID"     : menu_gid,
                "Menu Title"   : menu_title,
                "Menu Title TH": menu_title_th,
                "Menu Handle"  : menu_handle,
                "Level"        : 2,
                "Main Category": item_l1["title"],
                "Sub Category" : item_l2["title"],
                "Item Title"   : item_l2["title"],
                "Item Title TH": l2_title_th,
                "Item URL"     : item_l2.get("url", ""),
            })

            for item_l3 in item_l2.get("items", []):
                l3_id = item_l3.get("id", "")
                l3_link_id = l3_id.replace("gid://shopify/MenuItem/", "gid://shopify/Link/") if l3_id else ""
                l3_title_th = fetch_thai_translation(l3_link_id, key="title") if (fetch_trans and l3_link_id) else ""

                # Level 3 — Sub-sub item
                rows.append({
                    "Menu GID"     : menu_gid,
                    "Menu Title"   : menu_title,
                    "Menu Title TH": menu_title_th,
                    "Menu Handle"  : menu_handle,
                    "Level"        : 3,
                    "Main Category": item_l1["title"],
                    "Sub Category" : item_l2["title"],
                    "Item Title"   : item_l3["title"],
                    "Item Title TH": l3_title_th,
                    "Item URL"     : item_l3.get("url", ""),
                })
    return rows


def main():
    parser = argparse.ArgumentParser(description="Export Shopify menus to CSV")
    parser.add_argument("--fetch-translations", action="store_true", help="Fetch existing Thai translations for menu items")
    args = parser.parse_args()

    print("Fetching menus...")
    res = gql(API_URL, HEADERS, QUERY)
    if not res:
        print("[ERR] No response from API.")
        return

    edges = res.get("data", {}).get("menus", {}).get("edges", [])
    print(f"Found {len(edges)} menu(s).")

    all_rows = []
    for edge in edges:
        node = edge["node"]
        rows = flatten_items(
            menu_gid    = node["id"],
            menu_title  = node["title"],
            menu_handle = node["handle"],
            items       = node.get("items", []),
            fetch_trans = args.fetch_translations
        )
        all_rows.extend(rows)
        print(f"  [{node['title']}]  {len(rows)} item(s) (including sub-items)")

    if not all_rows:
        print("[INFO] No menu items found.")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    cols = [
        "Menu GID", "Menu Title", "Menu Title TH", "Menu Handle",
        "Level", "Main Category", "Sub Category",
        "Item Title", "Item Title TH", "Item URL",
    ]
    df = pd.DataFrame(all_rows, columns=cols)
    df.to_csv(OUT_FILE, index=False, encoding="utf-8-sig")
    print(f"\nExported {len(all_rows)} rows → {OUT_FILE}")


if __name__ == "__main__":
    main()
