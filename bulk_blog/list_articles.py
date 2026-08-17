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
import argparse

import blog_utils

normalize_blog_gid = blog_utils.normalize_blog_gid
fetch_blog_articles = blog_utils.fetch_blog_articles
fetch_known_blogs = blog_utils.fetch_known_blogs


def main():
    parser = argparse.ArgumentParser(description="List Shopify blog articles (for duplicate checks)")
    parser.add_argument("--blog", default=None, help="Blog GID or numeric ID. Omit to list every blog.")
    args = parser.parse_args()

    if args.blog:
        blog_gids = [normalize_blog_gid(args.blog)]
    else:
        known_blogs = fetch_known_blogs()
        if not known_blogs:
            print("[ERROR] Could not fetch blogs")
            sys.exit(1)
        blog_gids = list(known_blogs.keys())

    total = 0
    total_dupes = 0

    for blog_gid in blog_gids:
        blog_title, articles = fetch_blog_articles(blog_gid)
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
