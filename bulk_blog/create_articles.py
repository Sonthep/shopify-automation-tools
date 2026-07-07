import sys
import os
import argparse
import pandas as pd
import time
import importlib.util

# Load utils from bulk_product
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

# กำหนด Token ที่จะใช้ดึงจาก .env
HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

LOCALE_TH = "th"

ARTICLE_CREATE_MUTATION = """
mutation articleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article {
      id
      title
      image {
        url
      }
    }
    userErrors {
      field
      message
    }
  }
}
"""

ARTICLE_GET_DIGESTS = """
query GetArticleDigests($id: ID!) {
  translatableResource(resourceId: $id) {
    translatableContent {
      key
      digest
    }
  }
}
"""

ARTICLE_REGISTER_TRANSLATION = """
mutation RegisterTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations {
      key
      locale
    }
    userErrors {
      field
      message
    }
  }
}
"""

def register_thai_translation(article_id: str, title_th: str, body_th: str) -> dict:
    """ลงทะเบียน translation ภาษาไทยสำหรับ article ที่สร้างแล้ว"""
    # ดึง digest ของ article ก่อน
    res_digest = gql(API_URL, HEADERS, ARTICLE_GET_DIGESTS, {"id": article_id})
    if not res_digest:
        return {"status": "error", "message": "ไม่สามารถดึง digest ของ article ได้"}
    
    content_list = (
        res_digest.get("data", {})
        .get("translatableResource", {})
        .get("translatableContent", [])
    )
    digest_map = {item["key"]: item["digest"] for item in content_list}
    
    translations = []
    if title_th and "title" in digest_map:
        translations.append({
            "key": "title",
            "value": title_th,
            "locale": LOCALE_TH,
            "translatableContentDigest": digest_map["title"]
        })
    if body_th and "body_html" in digest_map:
        translations.append({
            "key": "body_html",
            "value": body_th,
            "locale": LOCALE_TH,
            "translatableContentDigest": digest_map["body_html"]
        })
    
    if not translations:
        return {"status": "skipped", "message": "ไม่มีข้อมูลภาษาไทยหรือไม่พบ digest"}
    
    res_reg = gql(API_URL, HEADERS, ARTICLE_REGISTER_TRANSLATION, {
        "resourceId": article_id,
        "translations": translations
    })
    if not res_reg:
        return {"status": "error", "message": "GraphQL request failed (translation)"}
    
    reg_data = res_reg.get("data", {}).get("translationsRegister", {})
    reg_errors = reg_data.get("userErrors", [])
    if reg_errors:
        err_msg = "; ".join([f"{e.get('field', [])}: {e.get('message')}" for e in reg_errors])
        return {"status": "error", "message": err_msg}
    
    keys_registered = [t["key"] for t in reg_data.get("translations", [])]
    return {"status": "success", "message": f"Registered TH keys: {keys_registered}"}


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
    
    # รองรับ Image URL + Alt text (featured image ของ article)
    image_url = get_val(row, "Image URL") or ""
    image_alt = get_val(row, "Image Alt") or ""
    if image_url:
        article_input["image"] = {"url": image_url}
        if image_alt:
            article_input["image"]["altText"] = image_alt
        
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
        
        th_status = ""
        if res["status"] == "success":
            print(f"✅ {res['article_id']}")
            success_count += 1
            
            # ลงทะเบียน translation ภาษาไทย (ถ้ามีข้อมูลใน column Title_TH / Body_TH)
            title_th = get_val(row, "Title_TH") or ""
            body_th = get_val(row, "Body_TH") or ""
            if title_th or body_th:
                print(f"   🇹🇭 Registering Thai translation...", end=" ")
                th_res = register_thai_translation(res["article_id"], title_th, body_th)
                if th_res["status"] == "success":
                    print(f"✅ {th_res['message']}")
                elif th_res["status"] == "skipped":
                    print(f"⏭️  {th_res['message']}")
                else:
                    print(f"❌ {th_res['message']}")
                th_status = th_res["status"]
                
        elif res["status"] == "skipped":
            print(f"⏭️  Skipped ({res['message']})")
        else:
            print(f"❌ ERROR: {res['message']}")
            error_count += 1
            
        results.append({
            "Title": title,
            "Status": res["status"],
            "Article ID": res.get("article_id", ""),
            "Message": res.get("message", ""),
            "TH Translation": th_status
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
