"""
Create Shopify menus from a flat CSV (same format as get_menus.py output).

Required CSV columns:
  - Menu Title   : Name of the menu (e.g. "Cooking Equipment")
  - Menu Handle  : URL handle   (e.g. "cooking-equipment")
  - Level        : 1 = Main item, 2 = Sub item, 3 = Sub-sub item
  - Main Category: Title of the Level-1 parent item
  - Item Title   : Title of this item
  - Item URL     : URL of this item (e.g. /collections/cooking-equipment)

  Optional:
  - Sub Category : Title of the Level-2 parent (only needed for Level 3 items)

Type is auto-detected from Item URL:
  /collections/all  → COLLECTIONS_LINK
  /collections/...  → COLLECTION_LINK
  /products/...     → PRODUCT_LINK
  /pages/...        → PAGE_LINK
  /blogs/...        → BLOG_LINK
  /                 → FRONTPAGE
  (empty / other)   → HTTP

Usage:
    py create_menus.py --csv ../bulk_product/data/test_create_menu.csv
    py create_menus.py --csv ../bulk_product/data/test_create_menu.csv --dry-run
"""
import sys, os, json
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL, get_val
import argparse
import pandas as pd

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

REQUIRED_COLS = ["Menu Title", "Menu Handle", "Level", "Main Category", "Item Title", "Item URL"]
# Sub Category is optional — only needed for Level 3 items


# ── Auto-detect item type from URL ────────────────────────────

def detect_type(url: str) -> str:
    """Infer Shopify MenuItemType from URL pattern.
    We force HTTP for everything to avoid Shopify's strict resourceId validation,
    unless it's the frontpage.
    """
    url = (url or "").strip()
    if not url or url == "#":
        return "HTTP"
    if url == "/":
        return "FRONTPAGE"
    return "HTTP"


def make_item(title: str, url: str, children: list) -> dict:
    """Build a single MenuItemCreateInput dict."""
    item_type = detect_type(url)
    # HTTP type requires a non-blank URL — use '#' as fallback for parent-only items
    item_url = url if url else ("#" if item_type == "HTTP" else None)
    return {
        "title": title,
        "type":  item_type,
        "url":   item_url,
        "items": children,
    }


# ── Build nested items structure from flat rows ───────────────

def build_items(group: pd.DataFrame) -> list:
    """Convert flat rows (Level 1/2/3) into nested MenuItemCreateInput list."""
    l1_items: dict = {}   # main_cat → {title, url, sub_items: {sub_cat → ...}}

    for _, row in group.iterrows():
        level    = str(get_val(row, "Level") or "").strip()
        main_cat = (get_val(row, "Main Category") or "").strip()
        sub_cat  = (get_val(row, "Sub Category")  or "").strip()
        title    = (get_val(row, "Item Title")    or "").strip()
        url      = (get_val(row, "Item URL")      or "").strip()

        if not title:
            if level == "1":
                title = main_cat
            elif level == "2":
                title = sub_cat

        if not title:
            continue

        if level == "1":
            if main_cat not in l1_items:
                l1_items[main_cat] = {"title": title, "url": url, "sub_items": {}}

        elif level == "2":
            if main_cat not in l1_items:
                l1_items[main_cat] = {"title": main_cat, "url": "", "sub_items": {}}
            if sub_cat not in l1_items[main_cat]["sub_items"]:
                l1_items[main_cat]["sub_items"][sub_cat] = {
                    "title": title, "url": url, "sub_sub_items": []
                }

        elif level == "3":
            if main_cat not in l1_items:
                l1_items[main_cat] = {"title": main_cat, "url": "", "sub_items": {}}
            if sub_cat not in l1_items[main_cat]["sub_items"]:
                l1_items[main_cat]["sub_items"][sub_cat] = {
                    "title": sub_cat, "url": "", "sub_sub_items": []
                }
            l1_items[main_cat]["sub_items"][sub_cat]["sub_sub_items"].append(
                {"title": title, "url": url}
            )

    # ── Convert to Shopify MenuItemCreateInput format ──
    result = []
    for l1 in l1_items.values():
        l2_list = []
        for l2 in l1["sub_items"].values():
            l3_list = [make_item(s["title"], s["url"], [])
                       for s in l2["sub_sub_items"]]
            l2_list.append(make_item(l2["title"], l2["url"], l3_list))
        result.append(make_item(l1["title"], l1["url"], l2_list))

    return result


# ── GraphQL mutation ──────────────────────────────────────────

MUTATION = """
mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
  menuCreate(title: $title, handle: $handle, items: $items) {
    menu { id title handle }
    userErrors { field message }
  }
}
"""


# ── Main ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Create Shopify menus from flat CSV")
    parser.add_argument("--csv",     required=True,       help="Path to flat CSV file")
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

    # Drop unnamed / blank columns
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]

    print(f"Columns : {df.columns.tolist()}")
    print(f"Rows    : {len(df)}\n")

    for col in REQUIRED_COLS:
        if col not in df.columns:
            print(f"[ERR] Missing required column: '{col}'")
            return

    # Group by Menu Title + Handle (one API call per menu)
    grouped = df.groupby(["Menu Title", "Menu Handle"], sort=False)
    print(f"Found {len(grouped)} menu(s) to create.\n")

    for (menu_title, menu_handle), group in grouped:
        items = build_items(group)
        print(f"── Menu: {menu_title} ({menu_handle})")
        print(f"   Items: {len(items)} top-level item(s)")

        if args.dry_run:
            print(f"   [DRY RUN] Payload:\n{json.dumps(items, indent=4, ensure_ascii=False)}\n")
            continue

        res  = gql(API_URL, HEADERS, MUTATION, {
            "title": menu_title, "handle": menu_handle, "items": items
        })
        data = (res or {}).get("data", {}).get("menuCreate", {})
        errs = data.get("userErrors", [])
        menu = data.get("menu")

        if errs:
            print(f"   [ERR] {errs}\n")
        elif menu:
            print(f"   [OK]  Created: {menu.get('title')} → {menu.get('id')}\n")
        else:
            print(f"   [WARN] Unexpected response: {data}\n")


if __name__ == "__main__":
    main()
