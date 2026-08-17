import sys
import os
import argparse
import pandas as pd
import time

import blog_utils

gql = blog_utils.gql
API_URL = blog_utils.API_URL
HEADERS = blog_utils.HEADERS
read_csv_auto = blog_utils.read_csv_auto
get_val = blog_utils.get_val
normalize_blog_gid = blog_utils.normalize_blog_gid
fetch_existing_titles = blog_utils.fetch_existing_titles
register_thai_translation = blog_utils.register_thai_translation

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

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


def create_article(row: pd.Series) -> dict:
    title = get_val(row, "Title")
    if not title:
        return {"status": "skipped", "message": "No Title"}
        
    blog_gid = get_val(row, "Blog GID")
    if not blog_gid:
        return {"status": "error", "message": "No Blog GID provided"}
        
    blog_gid = normalize_blog_gid(blog_gid)

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

    # Theme template ที่ใช้แสดงผล article (dropdown "Theme template" ในหน้า admin)
    theme_template = get_val(row, "Theme Template")
    if theme_template:
        article_input["templateSuffix"] = theme_template

    # รองรับ Image URL + Alt text (featured image ของ article)
    image_url = get_val(row, "Image URL") or ""
    image_alt = get_val(row, "Image Alt") or ""
    if image_url:
        article_input["image"] = {"url": image_url}
        if image_alt:
            article_input["image"]["altText"] = image_alt

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
        article_input["metafields"] = seo_metafields

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
    parser.add_argument("--allow-duplicates", action="store_true",
                         help="Skip the existing-title check and create even if a matching title already exists on the blog")
    args = parser.parse_args()

    input_file = args.csv
    if not os.path.exists(input_file):
        print(f"[ERROR] Input file not found: {input_file}")
        sys.exit(1)

    print(f"Reading {input_file}...")
    df = read_csv_auto(input_file)

    # ป้องกันสร้างซ้ำ: ดึงชื่อ article ที่มีอยู่แล้วของทุก blog ที่ปรากฏใน CSV ก่อนเริ่ม
    existing_by_blog = {}
    if not args.allow_duplicates:
        blog_gids = set()
        for _, row in df.iterrows():
            bg = get_val(row, "Blog GID")
            if bg:
                blog_gids.add(normalize_blog_gid(bg))
        for bg in blog_gids:
            print(f"Checking existing articles on {bg}...")
            existing_by_blog[bg] = fetch_existing_titles(bg)

    results = []
    success_count = 0
    error_count = 0
    skip_count = 0

    for idx, row in df.iterrows():
        title = get_val(row, "Title")
        blog_gid = normalize_blog_gid(get_val(row, "Blog GID") or "")
        print(f"[{idx+1}/{len(df)}] Creating: {title}...", end=" ")

        if not args.allow_duplicates:
            existing_id = existing_by_blog.get(blog_gid, {}).get(title)
            if existing_id:
                print(f"⏭️  Skipped (already exists: {existing_id})")
                skip_count += 1
                results.append({
                    "Title": title,
                    "Status": "skipped",
                    "Article ID": existing_id,
                    "Message": "Already exists on blog (use --allow-duplicates to force)",
                    "TH Translation": ""
                })
                continue

        res = create_article(row)

        th_status = ""
        if res["status"] == "success":
            print(f"✅ {res['article_id']}")
            success_count += 1

            if not args.allow_duplicates:
                existing_by_blog.setdefault(blog_gid, {})[title] = res["article_id"]

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
    print(f"Completed! Success: {success_count}, Skipped (duplicates): {skip_count}, Errors: {error_count}")
    print(f"Result log saved to: {out_file}")
    print("="*40)

if __name__ == "__main__":
    main()
