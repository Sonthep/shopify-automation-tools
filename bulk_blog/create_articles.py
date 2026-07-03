import sys
import os
import argparse
import pandas as pd
import time
import importlib.util

# Load utils from bulk-update-product
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
UTILS_PATH = os.path.join(ROOT_DIR, "bulk-update-product", "utils.py")

spec = importlib.util.spec_from_file_location("utils", UTILS_PATH)
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)

make_headers = utils.make_headers
gql = utils.gql
API_URL = utils.API_URL
read_csv_auto = utils.read_csv_auto
get_val = utils.get_val

# กำหนด Token ที่จะใช้ดึงจาก .env
HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

ARTICLE_CREATE_MUTATION = """
mutation articleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article {
      id
      title
    }
    userErrors {
      field
      message
    }
  }
}
"""

def create_article(row: pd.Series) -> dict:
    title = get_val(row, "Title")
    if not title:
        return {"status": "skipped", "message": "No Title"}
        
    blog_gid = get_val(row, "Blog GID")
    if not blog_gid:
        return {"status": "error", "message": "No Blog GID provided"}
        
    # Format GID just in case user provided only numbers
    if str(blog_gid).isdigit():
        blog_gid = f"gid://shopify/Blog/{blog_gid}"
        
    body = get_val(row, "Body") or ""
    author_name = get_val(row, "Author")
    
    tags_str = get_val(row, "Tags") or ""
    tags = [t.strip() for t in tags_str.split(",") if t.strip()]
    
    published_val = str(get_val(row, "Published") or "").strip().lower()
    is_published = published_val in ("true", "1", "yes", "y")

    article_input = {
        "blogId": blog_gid,
        "title": title,
        "body": body,
        "isPublished": is_published
    }
    
    if author_name:
        article_input["author"] = {"name": author_name}
    if tags:
        article_input["tags"] = tags
        
    variables = {"article": article_input}
    
    res = gql(API_URL, HEADERS, ARTICLE_CREATE_MUTATION, variables)
    if not res:
        return {"status": "error", "message": "GraphQL request failed"}
        
    data = res.get("data", {}).get("articleCreate", {})
    user_errors = data.get("userErrors", [])
    
    if user_errors:
        err_msg = "; ".join([f"{e.get('field', [])}: {e.get('message')}" for e in user_errors])
        return {"status": "error", "message": err_msg}
        
    article = data.get("article", {})
    return {
        "status": "success", 
        "article_id": article.get("id"),
        "message": f"Created '{article.get('title')}'"
    }

def main():
    parser = argparse.ArgumentParser(description="Bulk Create Shopify Articles (Blog Posts)")
    parser.add_argument("--csv", required=True, help="Path to input CSV file")
    args = parser.parse_args()

    input_file = args.csv
    if not os.path.exists(input_file):
        print(f"[ERROR] Input file not found: {input_file}")
        sys.exit(1)

    print(f"Reading {input_file}...")
    df = read_csv_auto(input_file)
    
    results = []
    success_count = 0
    error_count = 0

    for idx, row in df.iterrows():
        title = get_val(row, "Title")
        print(f"[{idx+1}/{len(df)}] Creating: {title}...", end=" ")
        
        res = create_article(row)
        
        if res["status"] == "success":
            print(f"✅ {res['article_id']}")
            success_count += 1
        elif res["status"] == "skipped":
            print(f"⏭️  Skipped ({res['message']})")
        else:
            print(f"❌ ERROR: {res['message']}")
            error_count += 1
            
        results.append({
            "Title": title,
            "Status": res["status"],
            "Article ID": res.get("article_id", ""),
            "Message": res.get("message", "")
        })
        
        # หน่วงเวลาเล็กน้อยเพื่อป้องกัน API limit
        time.sleep(0.5)

    # Save results
    output_dir = os.path.join(BASE_DIR, "output")
    os.makedirs(output_dir, exist_ok=True)
    
    out_file = os.path.join(output_dir, f"create_articles_result_{int(time.time())}.csv")
    pd.DataFrame(results).to_csv(out_file, index=False, encoding="utf-8-sig")
    
    print("\n" + "="*40)
    print(f"Completed! Success: {success_count}, Errors: {error_count}")
    print(f"Result log saved to: {out_file}")
    print("="*40)

if __name__ == "__main__":
    main()
