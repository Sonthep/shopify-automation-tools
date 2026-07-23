"""
upload_images_by_sku.py
Update Shopify product images by SKU — supports flat files AND sub-folder (multiple images per SKU).

Folder structure supported:
  FOLDER/
    SKU-001.jpg                  ← single image, flat file
    SKU-002.png                  ← single image, flat file
    SKU-003/                     ← multiple images
      SKU-003.jpg
      SKU-003 (2).jpg

Behaviour:
  1. Resolve SKU → Product GID + Variant GID via Shopify API
  2. Delete ALL existing media from the product
  3. Upload new images to S3 (staged upload)
  4. Create new product media (multiple if sub-folder)
  5. Associate the FIRST image to the variant

Usage:
    py upload_images_by_sku.py
    py upload_images_by_sku.py --folder "C:\\path\\to\\folder"
    py upload_images_by_sku.py --no-delete   # keep existing images
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import os
import sys
import time
import argparse
import mimetypes
import requests
from utils import make_headers, gql, API_URL

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HEADERS    = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}
DEFAULT_FOLDER = r"C:\Users\0125024\Downloads\upload_product_image_13769"

# ── GraphQL ───────────────────────────────────────────────────────────────────

STAGED_UPLOAD_MUTATION = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
"""

DELETE_MEDIA_MUTATION = """
mutation deleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    userErrors { field message }
  }
}
"""

CREATE_MEDIA_MUTATION = """
mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { id status }
    userErrors { field message }
  }
}
"""

VARIANT_ASSOCIATE_MUTATION = """
mutation variantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}
"""

# ── Step 1: Staged upload → S3 ────────────────────────────────────────────────

def staged_upload_image(file_path: str) -> str | None:
    """Upload local image → S3 → return resourceUrl"""
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
        print(f"    ⚠️ stagedUploadsCreate error: {errors}")
        return None

    target = body["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    extra  = {p["name"]: p["value"] for p in target["parameters"]}
    hdrs   = {"Content-Type": mime_type, "Content-Length": str(file_size), **extra}

    with open(file_path, "rb") as f:
        resp = requests.put(target["url"], data=f, headers=hdrs, timeout=120)
    if resp.status_code not in (200, 201):
        print(f"    ⚠️ S3 PUT failed HTTP {resp.status_code}: {filename}")
        return None

    return target["resourceUrl"]

# ── Step 2: Get existing media IDs ────────────────────────────────────────────

def get_media_ids(product_gid: str) -> list[str]:
    query = """
    query getMedia($id: ID!) {
      product(id: $id) {
        media(first: 50) { edges { node { id } } }
      }
    }"""
    body = gql(API_URL, HEADERS, query, {"id": product_gid})
    if not body:
        return []
    product_data = body.get("data", {}).get("product")
    if not product_data:
        return []
    return [e["node"]["id"] for e in product_data.get("media", {}).get("edges", [])]

# ── Step 3: Delete existing media ─────────────────────────────────────────────

def delete_media(product_gid: str, media_ids: list[str]):
    if not media_ids:
        return
    body   = gql(API_URL, HEADERS, DELETE_MEDIA_MUTATION, {"productId": product_gid, "mediaIds": media_ids})
    if not body:
        return
    result = body.get("data", {}).get("productDeleteMedia", {})
    if result.get("userErrors"):
        print(f"    ⚠️ Delete media errors: {result['userErrors']}")
    else:
        print(f"    🗑️  Deleted {len(result.get('deletedMediaIds', []))} old media")

# ── Step 4: Create new product media (batch) ──────────────────────────────────

def create_media_batch(product_gid: str, resource_urls: list[str]) -> list[str]:
    media_inputs = [{"originalSource": url, "mediaContentType": "IMAGE"} for url in resource_urls]
    body = gql(API_URL, HEADERS, CREATE_MEDIA_MUTATION, {"productId": product_gid, "media": media_inputs})
    if not body:
        return []
    result = body.get("data", {}).get("productCreateMedia", {})
    if result.get("userErrors"):
        print(f"    ⚠️ Create media errors: {result['userErrors']}")
        return []
    media_list = result.get("media", [])
    ids = [m["id"] for m in media_list if m.get("id")]
    print(f"    ✅ Created {len(ids)} product media")
    return ids

# ── Step 5: Associate first media to variant ──────────────────────────────────

def associate_media_to_variant(product_gid: str, variant_gid: str, media_id: str):
    body = gql(API_URL, HEADERS, VARIANT_ASSOCIATE_MUTATION, {
        "productId": product_gid,
        "variants":  [{"id": variant_gid, "mediaId": media_id}]
    })
    if not body:
        return
    result = body.get("data", {}).get("productVariantsBulkUpdate", {})
    if result.get("userErrors"):
        print(f"    ⚠️ Variant association error: {result['userErrors']}")
    else:
        print(f"    🔗 Associated first image to variant: {variant_gid}")

# ── Resolve SKUs ──────────────────────────────────────────────────────────────

def get_gids_by_skus(skus: list, batch_size: int = 50) -> dict:
    gid_map = {}
    total   = len(skus)
    for i in range(0, total, batch_size):
        batch   = skus[i:i + batch_size]
        aliases = "\n".join([
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") '
            f'{{ edges {{ node {{ id product {{ id }} }} }} }}'
            for j, sku in enumerate(batch)
        ])
        body = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            if edges:
                node = edges[0]["node"]
                gid_map[sku] = {
                    "variant_id": node["id"],
                    "product_id": node["product"]["id"]
                }
            else:
                gid_map[sku] = None
        print(f"  Resolved {min(i + batch_size, total)}/{total} SKUs")
        time.sleep(0.5)
    return gid_map

# ── Scan folder → collect SKU → image list mapping ───────────────────────────

def scan_folder(folder_path: str) -> dict:
    """
    Returns { sku: [image_path, ...] }
    Supports:
      - flat file:    SKU.jpg   → sku = filename without ext
      - sub-folder:  SKU/       → sku = folder name, images = all images inside
    """
    sku_images = {}

    entries = sorted(os.listdir(folder_path))
    for entry in entries:
        entry_path = os.path.join(folder_path, entry)

        if os.path.isfile(entry_path):
            ext = os.path.splitext(entry)[1].lower()
            if ext in IMAGE_EXTS:
                sku = os.path.splitext(entry)[0]
                sku_images.setdefault(sku, []).append(entry_path)

        elif os.path.isdir(entry_path):
            # sub-folder → SKU = folder name, collect all images inside (sorted)
            sku = entry
            imgs = sorted([
                os.path.join(entry_path, f)
                for f in os.listdir(entry_path)
                if os.path.isfile(os.path.join(entry_path, f))
                   and os.path.splitext(f)[1].lower() in IMAGE_EXTS
            ])
            if imgs:
                sku_images[sku] = imgs

    return sku_images

# ── Main ──────────────────────────────────────────────────────────────────────

def run_update(folder_path: str, delete_old: bool = True):
    if not os.path.isdir(folder_path):
        print(f"❌ Folder not found: {folder_path}")
        return

    sku_images = scan_folder(folder_path)
    if not sku_images:
        print(f"❌ No valid images found in: {folder_path}")
        return

    print(f"📂 Folder : {folder_path}")
    print(f"📋 SKUs found: {len(sku_images)}")
    for sku, imgs in sku_images.items():
        print(f"   • {sku}  ({len(imgs)} image{'s' if len(imgs)>1 else ''})")

    print("\n🔍 Resolving SKUs on Shopify...")
    gid_map = get_gids_by_skus(list(sku_images.keys()))

    success = 0
    failed  = 0
    total   = len(sku_images)

    for idx, (sku, img_paths) in enumerate(sku_images.items(), 1):
        print(f"\n🔄 [{idx}/{total}] SKU: {sku}")
        gids = gid_map.get(sku)
        if not gids:
            print(f"  ⚠️ Not found on Shopify — skipping")
            failed += 1
            continue

        product_id = gids["product_id"]
        variant_id = gids["variant_id"]

        # Upload all images → S3
        resource_urls = []
        for img_path in img_paths:
            print(f"  ⬆️ Uploading: {os.path.basename(img_path)}")
            url = staged_upload_image(img_path)
            if url:
                resource_urls.append(url)
            else:
                print(f"    ❌ Upload failed")

        if not resource_urls:
            print(f"  ❌ All uploads failed — skipping")
            failed += 1
            continue

        # Delete old media (optional)
        if delete_old:
            old_ids = get_media_ids(product_id)
            if old_ids:
                delete_media(product_id, old_ids)
                time.sleep(0.5)

        # Create new media batch
        new_media_ids = create_media_batch(product_id, resource_urls)
        if not new_media_ids:
            print(f"  ❌ Failed to create product media — skipping")
            failed += 1
            continue

        # Associate first image to variant
        time.sleep(0.3)
        associate_media_to_variant(product_id, variant_id, new_media_ids[0])

        success += 1
        time.sleep(0.5)

    print(f"\n{'='*50}")
    print(f"🎉 เสร็จสิ้น!")
    print(f"   ✅ สำเร็จ  : {success}/{total}")
    print(f"   ❌ ล้มเหลว : {failed}/{total}")
    print(f"{'='*50}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update Shopify product images by SKU (supports multi-image sub-folders)")
    parser.add_argument("--folder", "-f", default=DEFAULT_FOLDER,
                        help="Folder containing images (flat files or SKU sub-folders)")
    parser.add_argument("--no-delete", action="store_true",
                        help="Keep existing product images instead of replacing them")
    args = parser.parse_args()

    folder = args.folder if os.path.isabs(args.folder) else os.path.join(os.path.dirname(__file__), args.folder)
    run_update(folder, delete_old=not args.no_delete)
