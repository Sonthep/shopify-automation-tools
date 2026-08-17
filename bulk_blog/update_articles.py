"""
update_articles.py
-------------------
Bulk update existing Shopify articles by ID — the missing piece between
create_articles.py (create-only) and delete_articles.py (delete-only).
Avoids the delete+recreate cycle for fixing content that's already live.

CSV format (only "Article ID" is required — leave any other cell blank
to leave that field untouched on Shopify):
    Article ID, Title, Body, Author, Tags, Published, Image URL, Image Alt,
    Theme Template, SEO Title, SEO Description, Title_TH, Body_TH

  - Article ID     : numeric ID or full GID (gid://shopify/Article/...)
  - Tags           : comma-separated, REPLACES the article's entire tag list
  - Published      : true/false/yes/no/1/0 — leave blank to leave isPublished unchanged
  - Theme Template  : the "Theme template" dropdown in admin (Shopify's templateSuffix,
                       e.g. "premium" for templates/article.premium.liquid)
  - Title_TH / Body_TH : re-registers the Thai translation for that article

Usage:
  py update_articles.py --csv data/update_articles.csv
  py update_articles.py --csv data/update_articles.csv --dry-run
"""

import sys
import os
import argparse
import time
import pandas as pd

import blog_utils

gql = blog_utils.gql
API_URL = blog_utils.API_URL
HEADERS = blog_utils.HEADERS
read_csv_auto = blog_utils.read_csv_auto
get_val = blog_utils.get_val
normalize_article_gid = blog_utils.normalize_article_gid
register_thai_translation = blog_utils.register_thai_translation

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ARTICLE_UPDATE_MUTATION = """
mutation articleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id title }
    userErrors { field message }
  }
}
"""


def build_update_input(row: pd.Series) -> dict:
    """Only include fields that have a non-blank value in the row."""
    article = {}

    title = get_val(row, "Title")
    if title:
        article["title"] = title

    body = get_val(row, "Body")
    if body:
        article["body"] = body

    author_name = get_val(row, "Author")
    if author_name:
        article["author"] = {"name": author_name}

    tags_str = get_val(row, "Tags")
    if tags_str:
        parsed_tags = [t.strip() for t in tags_str.split(",") if t.strip()]
        if parsed_tags:
            article["tags"] = parsed_tags
        else:
            print(f"   [WARN] Tags cell '{tags_str}' parsed to no tags — leaving existing tags untouched")

    published_raw = get_val(row, "Published")
    if published_raw is not None and str(published_raw).strip() != "":
        article["isPublished"] = str(published_raw).strip().lower() in ("true", "1", "yes", "y")

    image_url = get_val(row, "Image URL")
    if image_url:
        article["image"] = {"url": image_url}
        image_alt = get_val(row, "Image Alt")
        if image_alt:
            article["image"]["altText"] = image_alt

    theme_template = get_val(row, "Theme Template")
    if theme_template:
        article["templateSuffix"] = theme_template

    # SEO: "Page title" / "Meta description" ในหน้า admin — Article ไม่มี field "seo" ตรงๆ
    # ต้องตั้งผ่าน metafield legacy namespace "global" (ยืนยันจาก article ที่ตั้งค่าไว้จริงในร้าน)
    seo_title = get_val(row, "SEO Title")
    seo_desc = get_val(row, "SEO Description")
    seo_metafields = []
    if seo_title:
        seo_metafields.append({"namespace": "global", "key": "title_tag", "value": seo_title, "type": "string"})
    if seo_desc:
        seo_metafields.append({"namespace": "global", "key": "description_tag", "value": seo_desc, "type": "string"})
    if seo_metafields:
        article["metafields"] = seo_metafields

    return article


def update_article(article_gid: str, article_input: dict) -> dict:
    res = gql(API_URL, HEADERS, ARTICLE_UPDATE_MUTATION, {"id": article_gid, "article": article_input})
    if not res:
        return {"status": "error", "message": "GraphQL request failed"}

    data = res.get("data", {}).get("articleUpdate", {})
    user_errors = data.get("userErrors", [])
    if user_errors:
        return {"status": "error", "message": "; ".join(f"{e.get('field')}: {e.get('message')}" for e in user_errors)}

    article = data.get("article", {})
    return {"status": "success", "article_id": article.get("id"), "message": f"Updated '{article.get('title')}'"}


def main():
    parser = argparse.ArgumentParser(description="Bulk Update Shopify Articles")
    parser.add_argument("--csv", required=True, help="Path to input CSV file (must have 'Article ID' column)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be sent, without calling Shopify")
    args = parser.parse_args()

    if not os.path.exists(args.csv):
        print(f"[ERROR] Input file not found: {args.csv}")
        sys.exit(1)

    print(f"Reading {args.csv}...")
    df = read_csv_auto(args.csv)

    if "Article ID" not in df.columns:
        print("[ERROR] CSV must have an 'Article ID' column")
        sys.exit(1)

    results = []
    success_count = 0
    error_count = 0
    skip_count = 0

    for idx, row in df.iterrows():
        raw_id = get_val(row, "Article ID")
        if not raw_id:
            print(f"[{idx+1}/{len(df)}] Skipped (no Article ID)")
            skip_count += 1
            continue

        article_gid = normalize_article_gid(raw_id)
        article_input = build_update_input(row)

        if not article_input:
            print(f"[{idx+1}/{len(df)}] {article_gid}: skipped (no fields to update)")
            skip_count += 1
            continue

        print(f"[{idx+1}/{len(df)}] Updating {article_gid} ({list(article_input.keys())})...", end=" ")

        if args.dry_run:
            print("DRY-RUN (not sent)")
            results.append({"Article ID": article_gid, "Status": "dry-run", "Message": str(article_input), "TH Translation": ""})
            continue

        res = update_article(article_gid, article_input)

        th_status = ""
        if res["status"] == "success":
            print("✅")
            success_count += 1

            title_th = get_val(row, "Title_TH") or ""
            body_th = get_val(row, "Body_TH") or ""
            if title_th or body_th:
                print(f"   🇹🇭 Registering Thai translation...", end=" ")
                th_res = register_thai_translation(article_gid, title_th, body_th)
                print("✅" if th_res["status"] == "success" else ("⏭️" if th_res["status"] == "skipped" else "❌"), th_res["message"])
                th_status = th_res["status"]
        else:
            print(f"❌ ERROR: {res['message']}")
            error_count += 1

        results.append({
            "Article ID": article_gid,
            "Status": res["status"],
            "Message": res.get("message", ""),
            "TH Translation": th_status
        })

        time.sleep(0.5)

    if not args.dry_run:
        output_dir = os.path.join(BASE_DIR, "output")
        os.makedirs(output_dir, exist_ok=True)
        out_file = os.path.join(output_dir, f"update_articles_result_{int(time.time())}.csv")
        pd.DataFrame(results).to_csv(out_file, index=False, encoding="utf-8-sig")
        print(f"\nResult log saved to: {out_file}")

    print("\n" + "=" * 40)
    print(f"Completed! Success: {success_count}, Skipped: {skip_count}, Errors: {error_count}")
    print("=" * 40)


if __name__ == "__main__":
    main()
