"""
Delete Shopify menus.
"""
import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "bulk_product")))
from utils import make_headers, gql, API_URL, read_csv_auto, get_val
import argparse

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

def main():
    parser = argparse.ArgumentParser(description="Delete Shopify menus from CSV")
    parser.add_argument("--csv", required=True, help="Path to CSV file")
    args = parser.parse_args()
    
    df = read_csv_auto(args.csv)
    if "Menu GID" not in df.columns:
        print("Required column 'Menu GID' not found in CSV.")
        return
        
    query = """
    mutation menuDelete($id: ID!) {
      menuDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }
    """
    for _, row in df.iterrows():
        gid = get_val(row, "Menu GID")
        if not gid: continue
        res = gql(API_URL, HEADERS, query, {"id": gid})
        data = res.get("data", {}).get("menuDelete", {}) if res else {}
        errs = data.get("userErrors", [])
        if errs:
            print(f"Error deleting {gid}: {errs}")
        else:
            print(f"Deleted {gid}")

if __name__ == "__main__":
    main()
