"""
Get Shopify menus and export to CSV.

Output columns:
  - Menu GID        : Shopify Menu GID
  - Menu Title      : Name of the navigation menu
  - Menu Handle     : Handle of the navigation menu
  - Level           : 1 = Main item, 2 = Sub item, 3 = Sub-sub item
  - Main Category   : Title of the Level-1 parent item
  - Sub Category    : Title of the Level-2 parent item (if applicable)
  - Item Title      : Title of this menu item
  - Item URL        : URL of this menu item

Usage:
    py get_menus.py
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL
import pandas as pd

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
OUT_DIR  = os.path.join(os.path.dirname(__file__), "output")
OUT_FILE = os.path.join(OUT_DIR, "menus_export.csv")


# ── GraphQL query ────────────────────────────────────────────

QUERY = """
query {
  menus(first: 250) {
    edges {
      node {
        id
        title
        handle
        items {
          title
          url
          items {
            title
            url
            items {
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


# ── Flatten menu items to rows ───────────────────────────────

def flatten_items(menu_gid: str, menu_title: str, menu_handle: str, items: list) -> list:
    """Recursively flatten menu items into individual rows."""
    rows = []
    for item_l1 in items:
        # Level 1 — Main item
        rows.append({
            "Menu GID"     : menu_gid,
            "Menu Title"   : menu_title,
            "Menu Handle"  : menu_handle,
            "Level"        : 1,
            "Main Category": item_l1["title"],
            "Sub Category" : "",
            "Item Title"   : item_l1["title"],
            "Item URL"     : item_l1.get("url", ""),
        })
        for item_l2 in item_l1.get("items", []):
            # Level 2 — Sub item
            rows.append({
                "Menu GID"     : menu_gid,
                "Menu Title"   : menu_title,
                "Menu Handle"  : menu_handle,
                "Level"        : 2,
                "Main Category": item_l1["title"],
                "Sub Category" : item_l2["title"],
                "Item Title"   : item_l2["title"],
                "Item URL"     : item_l2.get("url", ""),
            })
            for item_l3 in item_l2.get("items", []):
                # Level 3 — Sub-sub item
                rows.append({
                    "Menu GID"     : menu_gid,
                    "Menu Title"   : menu_title,
                    "Menu Handle"  : menu_handle,
                    "Level"        : 3,
                    "Main Category": item_l1["title"],
                    "Sub Category" : item_l2["title"],
                    "Item Title"   : item_l3["title"],
                    "Item URL"     : item_l3.get("url", ""),
                })
    return rows


# ── Main ─────────────────────────────────────────────────────

def main():
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
        )
        all_rows.extend(rows)
        print(f"  [{node['title']}]  {len(rows)} item(s) (including sub-items)")

    if not all_rows:
        print("[INFO] No menu items found.")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    df = pd.DataFrame(all_rows, columns=[
        "Menu GID", "Menu Title", "Menu Handle",
        "Level", "Main Category", "Sub Category",
        "Item Title", "Item URL",
    ])
    df.to_csv(OUT_FILE, index=False, encoding="utf-8-sig")
    print(f"\nExported {len(all_rows)} rows → {OUT_FILE}")


if __name__ == "__main__":
    main()
