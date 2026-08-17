"""
update_articles.py
-------------------
Bulk update existing Shopify articles by ID — the missing piece between
create_articles.py (create-only) and delete_articles.py (delete-only).
Avoids the delete+recreate cycle for fixing content that's already live.

CSV format (only "Article ID" is required — leave any other cell blank
to leave that field untouched on Shopify):
    Article ID, Title, Body, Author, Tags, Published, Image URL, Image Alt,
    SEO Title, SEO Description, Title_TH, Body_TH

  - Article ID : numeric ID or full GID (gid://shopify/Article/...)
  - Tags       : comma-separated, REPLACES the article's entire tag list
  - Published  : true/false/yes/no/1/0 — leave blank to leave isPublished unchanged
  - Title_TH / Body_TH : re-registers the Thai translation for that article

Usage:
  py update_articles.py --csv data/update_articles.csv
  py update_articles.py --csv data/update_articles.csv --dry-run
"""

import sys
import os
import argparse
import time
import importlib.util
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

LOCALE_TH = "th"

ARTICLE_UPDATE_MUTATION = """
mutation articleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id title }
    userErrors { field message }
  }
}
"""

ARTICLE_GET_DIGESTS = """
query GetArticleDigests($id: ID!) {
  translatableResource(resourceId: $id) {
    translatableContent { key digest }
  }
}
"""

ARTICLE_REGISTER_TRANSLATION = """
mutation RegisterTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { key locale }
    userErrors { field message }
  }
}
"""


def normalize_article_gid(value: str) -> str:
    value = str(value).strip()
    if value.isdigit():
        return f"gid://shopify/Article/{value}"
    return value


def register_thai_translation(article_id: str, title_th: str, body_th: str) -> dict:
    res_digest = gql(API_URL, HEADERS, ARTICLE_GET_DIGESTS, {"id": article_id})
    if not res_digest:
        return {"status": "error", "message": "Could not fetch article digests"}

    content_list = (
        res_digest.get("data", {})
        .get("translatableResource", {})
        .get("translatableContent", [])
    )
    digest_map = {item["key"]: item["digest"] for item in content_list}

    translations = []
    if title_th and "title" in digest_map:
        translations.append({
            "key": "title", "value": title_th, "locale": LOCALE_TH,
            "translatableContentDigest": digest_map["title"]
        })
    if body_th and "body_html" in digest_map:
        translations.append({
            "key": "body_html", "value": body_th, "locale": LOCALE_TH,
            "translatableContentDigest": digest_map["body_html"]
        })

    if not translations:
        return {"status": "skipped", "message": "No TH content or digest not found"}

    res_reg = gql(API_URL, HEADERS, ARTICLE_REGISTER_TRANSLATION, {
        "resourceId": article_id,
        "translations": translations
    })
    if not res_reg:
        return {"status": "error", "message": "GraphQL request failed (translation)"}

    reg_data = res_reg.get("data", {}).get("translationsRegister", {})
    reg_errors = reg_data.get("userErrors", [])
    if reg_errors:
        return {"status": "error", "message": "; ".join(f"{e.get('field')}: {e.get('message')}" for e in reg_errors)}

    keys_registered = [t["key"] for t in reg_data.get("translations", [])]
    return {"status": "success", "message": f"Registered TH keys: {keys_registered}"}


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
        article["tags"] = [t.strip() for t in tags_str.split(",") if t.strip()]

    published_raw = get_val(row, "Published")
    if published_raw is not None and str(published_raw).strip() != "":
        article["isPublished"] = str(published_raw).strip().lower() in ("true", "1", "yes", "y")

    image_url = get_val(row, "Image URL")
    if image_url:
        article["image"] = {"url": image_url}
        image_alt = get_val(row, "Image Alt")
        if image_alt:
            article["image"]["altText"] = image_alt

    seo_title = get_val(row, "SEO Title")
    seo_desc = get_val(row, "SEO Description")
    if seo_title or seo_desc:
        seo = {}
        if seo_title:
            seo["title"] = seo_title
        if seo_desc:
            seo["description"] = seo_desc
        article["seo"] = seo

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
