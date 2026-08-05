import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import os
import sys
import argparse
import mimetypes
import pandas as pd
import requests
import time
from utils import make_headers, get_product_gids_by_skus, gql, read_csv_auto, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}


# ── Staged upload (local file → S3 → Shopify) ────────────────
STAGED_UPLOAD_MUTATION = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
"""

def staged_upload_image(file_path: str) -> str | None:
    """Upload local image file → S3 → return resourceUrl"""
    filename  = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    mime_type = mimetypes.guess_type(file_path)[0] or "image/jpeg"

    body = gql(API_URL, HEADERS, STAGED_UPLOAD_MUTATION, {"input": [{
        "filename":   filename,
        "mimeType":   mime_type,
        "fileSize":   str(file_size),
        "httpMethod": "PUT",
        "resource":   "IMAGE",
    }]})
    if not body:
        return None

    errors = body.get("data", {}).get("stagedUploadsCreate", {}).get("userErrors", [])
    if errors:
        print(f"  ⚠️ stagedUploadsCreate error: {errors}")
        return None

    target = body["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    extra  = {p["name"]: p["value"] for p in target["parameters"]}
    hdrs   = {"Content-Type": mime_type, "Content-Length": str(file_size), **extra}

    with open(file_path, "rb") as f:
        resp = requests.put(target["url"], data=f, headers=hdrs, timeout=120)
    if resp.status_code not in (200, 201):
        print(f"  ⚠️ S3 PUT failed HTTP {resp.status_code}: {file_path}")
        return None

    return target["resourceUrl"]


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
    body  = gql(API_URL, HEADERS, query, {"id": product_gid})
    if not body:
        return []
    data  = body.get("data", {})
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
    body   = gql(API_URL, HEADERS, mutation, {"productId": product_gid, "mediaIds": media_ids})
    if not body:
        return
    result = body.get("data", {}).get("productDeleteMedia", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Delete errors: {result['userErrors']}")
    else:
        print(f"  🗑️ Deleted {len(result.get('deletedMediaIds', []))} media")


# ── Create new media ──────────────────────────────────────────
def create_media(product_gid, image_urls):
    # Use productSet to replace the product's files list in the exact order provided.
    # FileSetInput.originalSource accepts either an external URL or a staged upload resourceUrl.
    files_input = []
    for url in image_urls:
        # Derive a filename from the URL for nicer file names (query string removed)
        fname = os.path.basename(url.split("?")[0]) or "file"
        files_input.append({"originalSource": url, "filename": fname})

    mutation = """
    mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(input: $input, synchronous: $synchronous) {
        product {
          id
          media(first: 50) { edges { node { id } } }
        }
        productSetOperation { id status userErrors { code field message } }
        userErrors { code field message }
      }
    }"""

    variables = {"input": {"id": product_gid, "files": files_input}, "synchronous": True}
    body = gql(API_URL, HEADERS, mutation, variables)
    if not body:
        return
    result = body.get("data", {}).get("productSet", {})
    user_errors = result.get("userErrors", [])
    if user_errors:
        print(f"  ⚠️ productSet errors: {user_errors}")
        return

    product = result.get("product")
    if product:
        edges = product.get("media", {}).get("edges", [])
        print(f"  ✅ Set {len(edges)} media (order preserved)")
    else:
        op = result.get("productSetOperation")
        if op:
            print(f"  ✅ productSet operation: {op.get('id')} status={op.get('status')}")
        else:
            print("  ✅ productSet completed")


# ── Folder mode: scan folder, match filename → SKU ───────────
def run_folder_mode(folder: str):
    """รองรับ 2 รูปแบบ:
    1) โฟลเดอร์ย่อยชื่อเป็น SKU แล้วอัปโหลดรูปทั้งหมดในโฟลเดอร์นั้น
    2) (fallback เดิม) ชื่อไฟล์ = SKU เช่น PIM1-IM-50SC.jpg
    """
    if not os.path.isdir(folder):
        print(f"❌ ไม่พบโฟลเดอร์: '{folder}'")
        return

    from collections import defaultdict

    # โหมดใหม่: โฟลเดอร์ย่อย = SKU
    sku_dirs = sorted([
        d for d in os.listdir(folder)
        if os.path.isdir(os.path.join(folder, d))
    ])

    sku_files: dict[str, list[str]] = defaultdict(list)
    flat_files: list[str] = []
    single_folder_sku: str | None = None
    if sku_dirs:
        for sku in sku_dirs:
            sku_folder = os.path.join(folder, sku)
            for root, _, filenames in os.walk(sku_folder):
                for name in filenames:
                    if os.path.splitext(name)[1].lower() in IMAGE_EXTS:
                        sku_files[sku].append(os.path.join(root, name))

            if not sku_files[sku]:
                print(f"⚠️ ไม่มีไฟล์รูปในโฟลเดอร์ SKU: {sku_folder}")
    else:
        # โฟลเดอร์เดี่ยว: ใช้ชื่อโฟลเดอร์เป็น SKU ก่อน
        files = sorted([
            os.path.join(folder, f)
            for f in os.listdir(folder)
            if os.path.splitext(f)[1].lower() in IMAGE_EXTS
        ])
        if not files:
            print(f"❌ ไม่พบไฟล์รูปใน '{folder}'")
            return

        flat_files = files
        single_folder_sku = os.path.basename(os.path.normpath(folder)).strip()
        if single_folder_sku:
            sku_files[single_folder_sku] = files
            print(f"🧭 Single-folder mode: ใช้ชื่อโฟลเดอร์เป็น SKU = {single_folder_sku}")

    skus = list(sku_files.keys())
    total_files = sum(len(v) for v in sku_files.values())
    print(f"📂 Folder: {folder}")
    print(f"📋 {len(skus)} SKU(s), {total_files} file(s)")

    gid_map = get_product_gids_by_skus(API_URL, HEADERS, skus)

    # fallback เดิม: ถ้าใช้ชื่อโฟลเดอร์แล้วไม่เจอ SKU ค่อยจับคู่จากชื่อไฟล์แทน
    if single_folder_sku and not gid_map.get(single_folder_sku):
        print(f"⚠️ ไม่พบ SKU จากชื่อโฟลเดอร์: {single_folder_sku} -> ลองจับคู่จากชื่อไฟล์แทน")
        sku_files = defaultdict(list)
        for fp in flat_files:
            sku = os.path.splitext(os.path.basename(fp))[0]
            base_sku = sku.rsplit("_", 1)[0] if sku[-1].isdigit() and "_" in sku else sku
            sku_files[base_sku].append(fp)

        skus = list(sku_files.keys())
        print(f"📋 Fallback filename mode: {len(skus)} SKU(s)")
        gid_map = get_product_gids_by_skus(API_URL, HEADERS, skus)

    success = failed = 0
    for sku, fp_list in sku_files.items():
        gid = gid_map.get(sku)
        if not gid:
            print(f"⚠️ SKU not found: {sku}")
            failed += 1
            continue

        print(f"\n🔄 {sku} → {gid}")

        # Upload ไฟล์ทีละรูป → เก็บ resource_url
        resource_urls = []
        for fp in sorted(fp_list):
            print(f"   ⬆️  Uploading {os.path.basename(fp)}...")
            url = staged_upload_image(fp)
            if url:
                resource_urls.append(url)
            else:
                print(f"   ❌ Upload failed: {fp}")

        if not resource_urls:
            failed += 1
            continue

        # ลบรูปเก่า
        media_ids = get_media_ids(gid)
        print(f"   Found {len(media_ids)} existing media")
        delete_media(gid, media_ids)
        time.sleep(0.5)

        # สร้างรูปใหม่
        create_media(gid, resource_urls)
        success += 1
        time.sleep(0.5)

    print(f"\n🎉 Done! Success: {success} | Failed: {failed}")


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update product images from CSV or folder")
    group  = parser.add_mutually_exclusive_group()
    group.add_argument("--folder", "-f", help="โฟลเดอร์รูปภาพ (รองรับโฟลเดอร์ย่อยชื่อ SKU)")
    group.add_argument("--csv",    "-c", help="CSV file path (default: data/update_image_set2.csv)")
    args = parser.parse_args()

    base_dir = os.path.dirname(__file__)

    if args.folder:
        run_folder_mode(args.folder)
        sys.exit(0)

    # ── CSV mode (เดิม) ──────────────────────────────────────
    CSV_FILE = args.csv or os.path.join(base_dir, "data", "update_image_set2.csv")

    df = read_csv_auto(CSV_FILE)
    print(f"Columns found: {df.columns.tolist()}")

    sku_col = "Variant SKU" if "Variant SKU" in df.columns else ("sku" if "sku" in df.columns else None)
    img_col = "Image Src"   if "Image Src"   in df.columns else ("image_src" if "image_src" in df.columns else None)

    # detect a provided product GID column to allow skipping SKU lookups
    gid_candidates = ["Product GID", "product_gid", "product id", "product_id", "gid"]
    gid_col = next((c for c in gid_candidates if c in df.columns), None)

    if not img_col or img_col not in df.columns or (not sku_col and not gid_col):
        print(f"❌ Required columns not found. Available: {df.columns.tolist()}")
        exit(1)

    # keep only columns that exist and are relevant
    cols = [img_col]
    if sku_col and sku_col in df.columns:
        cols.insert(0, sku_col)
    if gid_col:
        cols.insert(0, gid_col)
    df = df[cols].copy()

    # drop rows without image
    df = df[df[img_col].notna()].copy()

    # drop rows where both gid and sku are missing
    if gid_col:
        if sku_col and sku_col in df.columns:
            df = df[~(df[gid_col].isna() & df[sku_col].isna())]
        else:
            df = df[~df[gid_col].isna()]
    else:
        df = df.dropna(subset=[sku_col])

    # รองรับหลาย URL ต่อ SKU/Product (comma-separated)
    df[img_col] = df[img_col].str.strip()

    # Build list of SKUs that still need GID lookup (rows where gid is empty)
    skus_to_lookup = []
    if gid_col and gid_col in df.columns:
        if sku_col and sku_col in df.columns:
            skus_to_lookup = df.loc[df[gid_col].isna(), sku_col].dropna().tolist()
        else:
            skus_to_lookup = []
    else:
        skus_to_lookup = df[sku_col].dropna().tolist()

    print(f"📋 {len(df)} rows to process (need to lookup {len(skus_to_lookup)} SKUs)")

    gid_map = {}
    if skus_to_lookup:
        gid_map = get_product_gids_by_skus(API_URL, HEADERS, skus_to_lookup)

    success = 0
    failed  = 0

    for _, row in df.iterrows():
        # Safely extract SKU if present
        sku = None
        if sku_col and sku_col in row.index and pd.notna(row[sku_col]):
            sku = row[sku_col]

        # Prefer explicit product GID from CSV when provided
        gid = None
        if gid_col and gid_col in row.index and pd.notna(row[gid_col]):
            gid = row[gid_col]
        else:
            gid = gid_map.get(sku) if sku else None

        if not gid:
            print(f"⚠️ Product GID/SKU not found (sku={sku})")
            failed += 1
            continue

        # รองรับหลาย URL ต่อ 1 product (comma-separated)
        image_urls = [u.strip() for u in str(row[img_col]).split(",") if u.strip()]

        display = sku if sku else gid
        print(f"\n🔄 {display} → {gid}")
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
