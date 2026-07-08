"""
Export Shopify navigation menus to Excel.

Fetches ALL menus via GraphQL (menus query) — including main-menu,
product menu, spare parts menu, etc. — and flattens to rows with:

  Menu Name | Level | Menu Item | Sub Menu | Sub-Sub Menu | Type | URL | Resource GID

Usage (from menu-importer/ root):
    py scripts/export_menu.py
    py scripts/export_menu.py --cat-only
    py scripts/export_menu.py --out output/menus.xlsx
    py scripts/export_menu.py --handle main-menu
"""
import sys, os as _os
# utils.py lives in bulk_product/ (two levels up from scripts/)
_ROOT = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..', 'bulk_product'))
sys.path.insert(0, _ROOT)

import argparse
import os
import sys
import time

import pandas as pd

from utils import make_headers, gql, API_URL

HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(os.path.dirname(__file__))  # menu-importer/


# ── GraphQL queries ───────────────────────────────────────────

# Fetch list of all menus (handle + id)
MENUS_LIST_QUERY = """
{
  menus(first: 50) {
    edges {
      node {
        id
        handle
        title
      }
    }
  }
}
"""

# Fetch single menu with 3 levels of items
MENU_DETAIL_QUERY = """
query getMenu($id: ID!) {
  menu(id: $id) {
    id
    title
    handle
    items {
      id
      title
      type
      url
      resourceId
      items {
        id
        title
        type
        url
        resourceId
        items {
          id
          title
          type
          url
          resourceId
        }
      }
    }
  }
}
"""


# ── Fetch functions ───────────────────────────────────────────

def fetch_all_menus() -> list[dict]:
    """Return list of {id, handle, title} for every menu in the store."""
    body = gql(API_URL, HEADERS, MENUS_LIST_QUERY)
    if not body:
        return []
    edges = body.get("data", {}).get("menus", {}).get("edges", [])
    menus = [e["node"] for e in edges]
    print(f"  Found {len(menus)} menus: {[m['handle'] for m in menus]}")
    return menus


def fetch_menu_detail(menu_id: str) -> dict | None:
    """Return full menu object with nested items."""
    body = gql(API_URL, HEADERS, MENU_DETAIL_QUERY, {"id": menu_id})
    if not body:
        return None
    return body.get("data", {}).get("menu")


# ── Flatten menu tree to rows ────────────────────────────────

def flatten_menu(menu: dict) -> list[dict]:
    """
    Flatten a 3-level menu tree into one row per leaf item.

    Output columns:
      Menu Name, Level 1 (menu), Level 2 (sub menu), Level 3 (sub-sub menu),
      Type, URL, Resource GID
    """
    rows = []
    menu_name = menu.get("title", "")

    for l1 in menu.get("items", []):
        l2_items = l1.get("items", [])

        if not l2_items:
            # Top-level leaf
            rows.append({
                "Menu Name":    menu_name,
                "Level":        1,
                "Menu":         l1["title"],
                "Sub Menu":     "",
                "Sub-Sub Menu": "",
                "Type":         l1.get("type", ""),
                "URL":          l1.get("url", ""),
                "Resource GID": l1.get("resourceId", "") or "",
            })
        else:
            for l2 in l2_items:
                l3_items = l2.get("items", [])

                if not l3_items:
                    rows.append({
                        "Menu Name":    menu_name,
                        "Level":        2,
                        "Menu":         l1["title"],
                        "Sub Menu":     l2["title"],
                        "Sub-Sub Menu": "",
                        "Type":         l2.get("type", ""),
                        "URL":          l2.get("url", ""),
                        "Resource GID": l2.get("resourceId", "") or "",
                    })
                else:
                    for l3 in l3_items:
                        rows.append({
                            "Menu Name":    menu_name,
                            "Level":        3,
                            "Menu":         l1["title"],
                            "Sub Menu":     l2["title"],
                            "Sub-Sub Menu": l3["title"],
                            "Type":         l3.get("type", ""),
                            "URL":          l3.get("url", ""),
                            "Resource GID": l3.get("resourceId", "") or "",
                        })
    return rows


def flatten_main_subcats(menu: dict, top_items: list[str]) -> list[dict]:
    """
    Export selected L1 items with L2 sub-categories and L3 sub-sub-categories.
    - If L2 has no children  → 1 row: Main + Sub + Sub-Sub=""
    - If L2 has children     → 1 row per L3 child: Main + Sub + Sub-Sub

    top_items: list of L1 titles to include, e.g. ['Product', 'Spare Parts']
    """
    rows = []
    target = {t.lower() for t in top_items}

    for l1 in menu.get("items", []):
        if l1["title"].lower() not in target:
            continue

        l2_items = l1.get("items", [])
        if not l2_items:
            rows.append({
                "Main Category":     l1["title"],
                "Sub Category":      "",
                "Sub-Sub Category":  "",
                "Type":              l1.get("type", ""),
                "URL":               l1.get("url", ""),
                "Collection GID":    l1.get("resourceId", "") or "",
            })
        else:
            for l2 in l2_items:
                l3_items = l2.get("items", [])
                if not l3_items:
                    # L2 leaf — no sub-sub
                    rows.append({
                        "Main Category":     l1["title"],
                        "Sub Category":      l2["title"],
                        "Sub-Sub Category":  "",
                        "Type":              l2.get("type", ""),
                        "URL":               l2.get("url", ""),
                        "Collection GID":    l2.get("resourceId", "") or "",
                    })
                else:
                    for l3 in l3_items:
                        rows.append({
                            "Main Category":     l1["title"],
                            "Sub Category":      l2["title"],
                            "Sub-Sub Category":  l3["title"],
                            "Type":              l3.get("type", ""),
                            "URL":               l3.get("url", ""),
                            "Collection GID":    l3.get("resourceId", "") or "",
                        })
    return rows



# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Export Shopify menus to Excel")
    parser.add_argument(
        "--out", default=os.path.join(BASE_DIR, "output", "menus_export.xlsx"),
        help="Output Excel file path"
    )
    parser.add_argument(
        "--handle", default="",
        help="Export only a specific menu by handle (e.g. main-menu). Default: all menus."
    )
    parser.add_argument(
        "--cat-only", action="store_true",
        help="Export only 'Product' and 'Spare Parts' top-level + their sub-categories."
    )
    parser.add_argument(
        "--cat-out",
        default=os.path.join(BASE_DIR, "output", "menu_categories.xlsx"),
        help="Output Excel path for --cat-only export"
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    # ── 1. Get menu list ──
    print("Fetching menu list...")
    all_menus = fetch_all_menus()
    if not all_menus:
        print("[ERR] No menus found.")
        sys.exit(1)

    # Filter by handle if specified
    if args.handle:
        all_menus = [m for m in all_menus if m["handle"] == args.handle]
        if not all_menus:
            print(f"[ERR] No menu with handle '{args.handle}' found.")
            sys.exit(1)

    # ── 2. Fetch detail & flatten each menu ──
    all_rows = []
    cat_rows = []  # for --cat-only

    for m in all_menus:
        print(f"\nFetching menu: {m['title']} ({m['handle']})...")
        detail = fetch_menu_detail(m["id"])
        if not detail:
            print(f"  [WARN] Could not fetch menu {m['handle']}")
            continue

        rows = flatten_menu(detail)
        print(f"  → {len(rows)} rows (full)")
        all_rows.extend(rows)

        # Also collect cat-only rows from main-menu
        if m["handle"] == "main-menu":
            cat_rows = flatten_main_subcats(detail, ["Product", "Spare Parts"])
            print(f"  → {len(cat_rows)} rows (Product + Spare Parts sub-cats)")

        time.sleep(0.2)

    if not all_rows:
        print("[INFO] No menu items found.")
        sys.exit(0)

    # ── 3a. --cat-only export ──
    if args.cat_only:
        if not cat_rows:
            print("[ERR] No Product/Spare Parts rows found in main-menu.")
            sys.exit(1)
        os.makedirs(os.path.dirname(args.cat_out), exist_ok=True)
        df_cat = pd.DataFrame(cat_rows, columns=[
            "Main Category", "Sub Category", "Sub-Sub Category", "Type", "URL", "Collection GID",
        ])
        with pd.ExcelWriter(args.cat_out, engine="openpyxl") as writer:
            df_cat.to_excel(writer, sheet_name="All", index=False)
            for cat, grp in df_cat.groupby("Main Category"):
                grp.to_excel(writer, sheet_name=str(cat)[:31], index=False)
        print(f"\n✅ {len(cat_rows)} rows → {args.cat_out}")
        prod_rows  = df_cat[df_cat["Main Category"] == "Product"]
        spare_rows = df_cat[df_cat["Main Category"] == "Spare Parts"]
        print(f"   Product    : {prod_rows['Sub Category'].nunique()} sub-cats, {len(prod_rows)} total rows")
        print(f"   Spare Parts: {spare_rows['Sub Category'].nunique()} sub-cats, {len(spare_rows)} total rows")
        return


    # ── 3b. Full export to Excel ──
    df = pd.DataFrame(all_rows, columns=[
        "Menu Name", "Level", "Menu", "Sub Menu", "Sub-Sub Menu",
        "Type", "URL", "Resource GID",
    ])

    # Write with per-sheet tabs for each menu
    with pd.ExcelWriter(args.out, engine="openpyxl") as writer:
        # All menus combined
        df.to_excel(writer, sheet_name="All Menus", index=False)

        # One sheet per menu
        for menu_name, group in df.groupby("Menu Name"):
            sheet = str(menu_name)[:31]  # Excel limit: 31 chars
            group.to_excel(writer, sheet_name=sheet, index=False)

    print(f"\n✅ {len(all_rows)} rows → {args.out}")
    print(f"   Sheets: All Menus + {df['Menu Name'].nunique()} per-menu sheets")



if __name__ == "__main__":
    main()
