"""
validate_csv.py
----------------
Pre-flight check for a create_articles.py / update_articles.py CSV —
catches exactly the failures already seen in output/ before you burn an
API call on them:
  - missing/invalid Blog GID ("Must reference an existing blog")
  - dead image URLs, e.g. expired chatgpt.com links ("Image upload failed")
  - duplicate titles, within the CSV itself or already live on the blog

Does not modify anything or call any mutation — read-only.

Usage:
  py validate_csv.py --csv data/sample_articles_ready.csv
  py validate_csv.py --csv data/sample_articles_ready.csv --skip-image-check
"""

import sys
import os
import re
import argparse
import importlib.util
import requests
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
UTILS_PATH = os.path.join(ROOT_DIR, "bulk_product", "utils.py")

spec = importlib.util.spec_from_file_location("utils", UTILS_PATH)
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)

make_headers = utils.make_headers
gql = utils.gql
API_URL = utils.API_URL
read_csv_auto = utils.read_csv_auto
get_val = utils.get_val

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

IMG_TAG_RE = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']', re.IGNORECASE)
VALID_PUBLISHED_VALUES = {"true", "false", "1", "0", "yes", "no", "y", "n", ""}

BLOGS_QUERY = "{ blogs(first: 50) { edges { node { id title } } } }"

EXISTING_ARTICLES_QUERY = """
query BlogArticles($id: ID!, $cursor: String) {
  blog(id: $id) {
    articles(first: 250, after: $cursor) {
      edges { node { id title } }
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


def fetch_known_blogs() -> dict:
    """Returns {blog_gid: title}."""
    res = gql(API_URL, HEADERS, BLOGS_QUERY)
    if not res:
        return {}
    return {e["node"]["id"]: e["node"]["title"] for e in res["data"]["blogs"]["edges"]}


def fetch_existing_titles(blog_gid: str) -> set:
    titles = set()
    cursor = None
    while True:
        res = gql(API_URL, HEADERS, EXISTING_ARTICLES_QUERY, {"id": blog_gid, "cursor": cursor})
        if not res or not res.get("data") or not res["data"].get("blog"):
            break
        conn = res["data"]["blog"]["articles"]
        titles.update(e["node"]["title"] for e in conn["edges"])
        if conn["pageInfo"]["hasNextPage"]:
            cursor = conn["pageInfo"]["endCursor"]
        else:
            break
    return titles


def url_is_reachable(url: str, timeout: int = 10) -> tuple:
    """Returns (ok, detail). Tries HEAD first, falls back to a streamed GET
    since some hosts (e.g. chatgpt.com backend URLs) don't support HEAD."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; ShopifyCsvValidator/1.0)"}
    try:
        r = requests.head(url, timeout=timeout, headers=headers, allow_redirects=True)
        if r.status_code < 400:
            return True, f"HTTP {r.status_code}"
        if r.status_code in (405, 403):
            r = requests.get(url, timeout=timeout, headers=headers, stream=True)
            r.close()
            if r.status_code < 400:
                return True, f"HTTP {r.status_code} (GET)"
        return False, f"HTTP {r.status_code}"
    except Exception as e:
        return False, str(e)


def extract_body_image_urls(html: str) -> list:
    if not html or (isinstance(html, float)):
        return []
    return list(dict.fromkeys(IMG_TAG_RE.findall(str(html))))


def main():
    parser = argparse.ArgumentParser(description="Validate a bulk_blog CSV before create/update")
    parser.add_argument("--csv", required=True, help="Path to CSV file")
    parser.add_argument("--skip-image-check", action="store_true", help="Skip the HTTP reachability check on image URLs (faster)")
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        print(f"[ERROR] File not found: {args.csv}")
        sys.exit(1)

    print(f"Reading {args.csv}...")
    df = read_csv_auto(args.csv)

    print("Fetching known blogs...")
    known_blogs = fetch_known_blogs()
    for gid, title in known_blogs.items():
        print(f"  {gid}  {title}")

    existing_by_blog = {}
    seen_titles_in_csv = {}

    errors = []
    warnings = []
    checked_urls = {}

    for idx, row in df.iterrows():
        line = idx + 2  # +1 for 0-index, +1 for header row
        title = get_val(row, "Title")

        if not title:
            errors.append((line, "No Title"))
            continue

        if title in seen_titles_in_csv:
            errors.append((line, f"Duplicate title within this CSV (also row {seen_titles_in_csv[title]}): '{title}'"))
        else:
            seen_titles_in_csv[title] = line

        blog_gid_raw = get_val(row, "Blog GID")
        if not blog_gid_raw:
            errors.append((line, f"'{title}': No Blog GID"))
        else:
            blog_gid = normalize_blog_gid(blog_gid_raw)
            if blog_gid not in known_blogs:
                errors.append((line, f"'{title}': Blog GID {blog_gid} does not match any known blog"))
            else:
                if blog_gid not in existing_by_blog:
                    print(f"Checking existing articles on {known_blogs[blog_gid]} ({blog_gid})...")
                    existing_by_blog[blog_gid] = fetch_existing_titles(blog_gid)
                if title in existing_by_blog[blog_gid]:
                    warnings.append((line, f"'{title}': already exists on {known_blogs[blog_gid]} (create_articles.py will skip it)"))

        published_raw = str(get_val(row, "Published") or "").strip().lower()
        if published_raw not in VALID_PUBLISHED_VALUES:
            warnings.append((line, f"'{title}': Published value '{published_raw}' not recognized, will default to False"))

        if not args.skip_image_check:
            urls_to_check = []
            image_url = get_val(row, "Image URL")
            if image_url:
                urls_to_check.append(("Image URL", image_url))
            for col in ("Body", "Body_TH"):
                for u in extract_body_image_urls(get_val(row, col)):
                    urls_to_check.append((col, u))

            for source_col, url in urls_to_check:
                if url in checked_urls:
                    ok, detail = checked_urls[url]
                else:
                    ok, detail = url_is_reachable(url)
                    checked_urls[url] = (ok, detail)
                if not ok:
                    errors.append((line, f"'{title}': dead image URL in {source_col} ({detail}): {url[:100]}"))

    print("\n" + "=" * 60)
    if warnings:
        print(f"⚠️  {len(warnings)} warning(s):")
        for line, msg in warnings:
            print(f"  Row {line}: {msg}")
    if errors:
        print(f"❌ {len(errors)} error(s):")
        for line, msg in errors:
            print(f"  Row {line}: {msg}")
    if not errors and not warnings:
        print("✅ No issues found — safe to run create_articles.py")
    print("=" * 60)

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
