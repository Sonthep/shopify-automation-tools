"""
delete_articles.py
-------------------
Bulk delete Shopify articles by ID. Use this to clean up duplicates or
mistakes created by create_articles.py (e.g. from a retried run).

Usage:
  py delete_articles.py --id 643110502599
  py delete_articles.py --id gid://shopify/Article/643110502599,gid://shopify/Article/123456789
  py delete_articles.py --csv output/create_articles_result_XXXX.csv   # deletes every row with an Article ID
  py delete_articles.py --id 643110502599 --yes                        # skip the confirmation prompt
"""

import sys
import os
import argparse
import time

import blog_utils

gql = blog_utils.gql
API_URL = blog_utils.API_URL
HEADERS = blog_utils.HEADERS
read_csv_auto = blog_utils.read_csv_auto
get_val = blog_utils.get_val
normalize_article_gid = blog_utils.normalize_article_gid

ARTICLE_DELETE_MUTATION = """
mutation articleDelete($id: ID!) {
  articleDelete(id: $id) {
    deletedArticleId
    userErrors { field message }
  }
}
"""


def delete_article(article_gid: str) -> dict:
    res = gql(API_URL, HEADERS, ARTICLE_DELETE_MUTATION, {"id": article_gid})
    if not res:
        return {"status": "error", "message": "GraphQL request failed"}

    data = res.get("data", {}).get("articleDelete", {})
    errors = data.get("userErrors", [])
    if errors:
        msg = "; ".join(f"{e.get('field')}: {e.get('message')}" for e in errors)
        return {"status": "error", "message": msg}

    deleted_id = data.get("deletedArticleId")
    if not deleted_id:
        return {"status": "error", "message": "No deletedArticleId returned"}
    return {"status": "success", "message": f"Deleted {deleted_id}"}


def gather_ids_from_csv(csv_path: str) -> list:
    df = read_csv_auto(csv_path)
    ids = []
    for _, row in df.iterrows():
        aid = get_val(row, "Article ID")
        if aid:
            ids.append(str(aid).strip())
    return ids


def main():
    parser = argparse.ArgumentParser(description="Bulk delete Shopify articles")
    parser.add_argument("--id", help="Comma-separated Article ID(s) or GID(s)")
    parser.add_argument("--csv", help="CSV with an 'Article ID' column (e.g. a create_articles.py result file)")
    parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt")
    args = parser.parse_args()

    if not args.id and not args.csv:
        print("[ERROR] Provide --id or --csv")
        sys.exit(1)

    ids = []
    if args.id:
        ids.extend(x.strip() for x in args.id.split(",") if x.strip())
    if args.csv:
        if not os.path.exists(args.csv):
            print(f"[ERROR] File not found: {args.csv}")
            sys.exit(1)
        ids.extend(gather_ids_from_csv(args.csv))

    ids = [normalize_article_gid(i) for i in ids]
    ids = list(dict.fromkeys(ids))  # dedupe, preserve order

    if not ids:
        print("No article IDs to delete.")
        return

    print(f"About to permanently delete {len(ids)} article(s):")
    for i in ids:
        print(f"  {i}")

    if not args.yes:
        try:
            confirm = input(f"\nType 'yes' to confirm deleting {len(ids)} article(s): ").strip().lower()
        except EOFError:
            print("\n[ERROR] No terminal input available to confirm. Re-run with --yes to skip the prompt.")
            sys.exit(1)
        if confirm != "yes":
            print("Aborted.")
            return

    success, failed = 0, 0
    for i, aid in enumerate(ids, 1):
        print(f"[{i}/{len(ids)}] Deleting {aid}...", end=" ")
        res = delete_article(aid)
        if res["status"] == "success":
            print("✅")
            success += 1
        else:
            print(f"❌ {res['message']}")
            failed += 1
        time.sleep(0.3)

    print(f"\nDone. Deleted: {success}, Failed: {failed}")


if __name__ == "__main__":
    main()
