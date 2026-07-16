"""
Update Shopify menus from a flat CSV.

Required CSV columns:
  - Menu GID     : The GraphQL ID of the menu to update (e.g. gid://shopify/Menu/123)
  - Menu Title   : Name of the menu (e.g. "Cooking Equipment")
  - Menu Handle  : URL handle   (e.g. "cooking-equipment")
  - Level        : 1 = Main item, 2 = Sub item, 3 = Sub-sub item
  - Main Category: Title of the Level-1 parent item
  - Item Title   : Title of this item
  - Item URL     : URL of this item (e.g. /collections/cooking-equipment)

  Optional:
  - Sub Category : Title of the Level-2 parent (only needed for Level 3 items)

Note: This will overwrite ALL items in the menu with the new items provided.
"""
import sys, os, json
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL, get_val
import argparse
import pandas as pd
from create_menus import build_items

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
REQUIRED_COLS = ["Menu GID", "Menu Title", "Menu Handle", "Level", "Main Category", "Item Title", "Item URL"]

MUTATION = """
mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id title handle }
    userErrors { field message }
  }
}
"""

def main():
    parser = argparse.ArgumentParser(description="Update Shopify menus from flat CSV")
    parser.add_argument("--csv", required=True, help="Path to flat CSV file")
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

    # Group by Menu GID (one API call per menu)
    grouped = df.groupby(["Menu GID", "Menu Title", "Menu Handle"], sort=False)
    print(f"Found {len(grouped)} menu(s) to update.\n")

    for (menu_gid, menu_title, menu_handle), group in grouped:
        if not menu_gid: continue
        
        items = build_items(group)
        print(f"── Menu: {menu_title} ({menu_handle}) -> {menu_gid}")
        print(f"   Items: {len(items)} top-level item(s)")

        if args.dry_run:
            print(f"   [DRY RUN] Payload:\n{json.dumps(items, indent=4, ensure_ascii=False)}\n")
            continue

        res  = gql(API_URL, HEADERS, MUTATION, {
            "id": menu_gid, "title": menu_title, "handle": menu_handle, "items": items
        })
        data = (res or {}).get("data", {}).get("menuUpdate", {})
        errs = data.get("userErrors", [])
        menu = data.get("menu")

        if errs:
            print(f"   [ERR] {errs}\n")
        elif menu:
            print(f"   [OK]  Updated: {menu.get('title')} → {menu.get('id')}\n")
        else:
            print(f"   [WARN] Unexpected response: {data}\n")

if __name__ == "__main__":
    main()
