import os
import requests
import pandas as pd
import time
from utils import make_headers, get_product_gids_by_skus, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")


# ── Get existing media IDs for a product ─────────────────────
def get_media_ids(product_gid):
    query = """
    query getMedia($id: ID!) {
      product(id: $id) {
        media(first: 50) {
          edges { node { id } }
        }
      }
    }"""
    res  = requests.post(API_URL, json={"query": query, "variables": {"id": product_gid}}, headers=HEADERS)
    data = res.json().get("data", {})
    edges = data.get("product", {}).get("media", {}).get("edges", [])
    return [e["node"]["id"] for e in edges]


# ── Delete all existing media ─────────────────────────────────
def delete_media(product_gid, media_ids):
    if not media_ids:
        return
    mutation = """
    mutation deleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors { field message }
      }
    }"""
    res  = requests.post(API_URL, json={
        "query": mutation,
        "variables": {"productId": product_gid, "mediaIds": media_ids}
    }, headers=HEADERS)
    result = res.json().get("data", {}).get("productDeleteMedia", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Delete errors: {result['userErrors']}")
    else:
        print(f"  🗑️ Deleted {len(result.get('deletedMediaIds', []))} media")


# ── Create new media ──────────────────────────────────────────
def create_media(product_gid, image_urls):
    media_input = [
        {"originalSource": url, "mediaContentType": "IMAGE"}
        for url in image_urls
    ]
    mutation = """
    mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id status }
        userErrors { field message }
      }
    }"""
    res  = requests.post(API_URL, json={
        "query": mutation,
        "variables": {"productId": product_gid, "media": media_input}
    }, headers=HEADERS)
    result = res.json().get("data", {}).get("productCreateMedia", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Create errors: {result['userErrors']}")
    else:
        print(f"  ✅ Created {len(result.get('media', []))} media")


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    base_dir = os.path.dirname(__file__)
    CSV_FILE = os.path.join(base_dir, "update_image.csv")

    df = pd.read_csv(CSV_FILE)
    print(f"Columns found: {df.columns.tolist()}")

    sku_col = "Variant SKU" if "Variant SKU" in df.columns else "sku"
    img_col = "Image Src"   if "Image Src"   in df.columns else "image_src"

    if sku_col not in df.columns or img_col not in df.columns:
        print(f"❌ Required columns not found. Available: {df.columns.tolist()}")
        exit(1)

    # กรองเฉพาะ row ที่มีทั้ง SKU และ Image Src
    df = df[[sku_col, img_col]].dropna()
    # รองรับหลาย URL ต่อ SKU (comma-separated)
    df[img_col] = df[img_col].str.strip()

    skus = df[sku_col].tolist()
    print(f"📋 {len(skus)} SKUs to process")

    gid_map = get_product_gids_by_skus(API_URL, HEADERS, skus)

    success = 0
    failed  = 0

    for _, row in df.iterrows():
        sku = row[sku_col]
        gid = gid_map.get(sku)

        if not gid:
            print(f"⚠️ SKU not found: {sku}")
            failed += 1
            continue

        # รองรับหลาย URL ต่อ 1 product (comma-separated)
        image_urls = [u.strip() for u in str(row[img_col]).split(",") if u.strip()]

        print(f"\n🔄 {sku} → {gid}")
        print(f"   Images: {image_urls}")

        # 1. ดึง media เก่า
        media_ids = get_media_ids(gid)
        print(f"   Found {len(media_ids)} existing media")

        # 2. ลบ media เก่า
        delete_media(gid, media_ids)
        time.sleep(0.5)

        # 3. Upload รูปใหม่
        create_media(gid, image_urls)

        success += 1
        time.sleep(0.5)  # rate limit

    print(f"\n🎉 Done! Success: {success} | Failed: {failed}")
