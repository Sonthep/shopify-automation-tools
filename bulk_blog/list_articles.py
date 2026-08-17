"""
list_articles.py
-----------------
List articles for a given blog (or every blog) on Shopify, with duplicate
titles flagged. Use this before/after running create_articles.py to check
what's actually live, instead of trusting the local output/ result CSVs.

Usage:
  py list_articles.py                      # all blogs
  py list_articles.py --blog 99382919367   # one blog, by numeric ID
  py list_articles.py --blog gid://shopify/Blog/99382919367
"""

import sys
import os
import argparse
import importlib.util

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
UTILS_PATH = os.path.join(ROOT_DIR, "bulk_product", "utils.py")

spec = importlib.util.spec_from_file_location("utils", UTILS_PATH)
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)

make_headers = utils.make_headers
gql = utils.gql
API_URL = utils.API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

BLOGS_QUERY = """
{ blogs(first: 50) { edges { node { id title } } } }
"""

ARTICLES_QUERY = """
query BlogArticles($id: ID!, $cursor: String) {
  blog(id: $id) {
    title
    articles(first: 250, after: $cursor) {
      edges { node { id title isPublished createdAt } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


def normalize_blog_gid(value: str) -> str:
    value = str(value).strip()
    if value.isdigit():
        return f"gid://shopify/Blog/{value}"
    return value


def fetch_articles(blog_gid: str):
    """Returns (blog_title, [article_node, ...]) with pagination handled."""
    articles = []
    cursor = None
    blog_title = None

    while True:
        res = gql(API_URL, HEADERS, ARTICLES_QUERY, {"id": blog_gid, "cursor": cursor})
        if not res or not res.get("data") or not res["data"].get("blog"):
            print(f"[ERROR] Could not fetch blog {blog_gid}")
            break

        blog = res["data"]["blog"]
        blog_title = blog["title"]
        conn = blog["articles"]
        articles.extend(edge["node"] for edge in conn["edges"])

        if conn["pageInfo"]["hasNextPage"]:
            cursor = conn["pageInfo"]["endCursor"]
        else:
            break

    return blog_title, articles


def main():
    parser = argparse.ArgumentParser(description="List Shopify blog articles (for duplicate checks)")
    parser.add_argument("--blog", default=None, help="Blog GID or numeric ID. Omit to list every blog.")
    args = parser.parse_args()

    if args.blog:
        blog_gids = [normalize_blog_gid(args.blog)]
    else:
        res = gql(API_URL, HEADERS, BLOGS_QUERY)
        if not res:
            print("[ERROR] Could not fetch blogs")
            sys.exit(1)
        blog_gids = [edge["node"]["id"] for edge in res["data"]["blogs"]["edges"]]

    total = 0
    total_dupes = 0

    for blog_gid in blog_gids:
        blog_title, articles = fetch_articles(blog_gid)
        print(f"\n=== Blog: {blog_title or '?'} ({blog_gid}) — {len(articles)} article(s) ===")

        title_counts = {}
        for a in articles:
            status = "published" if a["isPublished"] else "draft"
            print(f"  {a['createdAt']}  {a['id']}  [{status}]  {a['title']}")
            title_counts[a["title"]] = title_counts.get(a["title"], 0) + 1

        dupes = {t: n for t, n in title_counts.items() if n > 1}
        if dupes:
            print("  ⚠️  Duplicate titles:")
            for t, n in dupes.items():
                print(f"     {n}x  {t}")
            total_dupes += sum(dupes.values())

        total += len(articles)

    print(f"\n{'='*50}")
    print(f"Total articles across {len(blog_gids)} blog(s): {total}")
    if total_dupes:
        print(f"⚠️  {total_dupes} article(s) involved in duplicate titles — review before creating more.")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
