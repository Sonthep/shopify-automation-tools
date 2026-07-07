"""
Shopify image updater by SKU matching image filenames.

This script scans a folder (default: 'update_image') for image files.
Each image filename (without extension) is treated as a SKU (e.g. TAC1-A6.jpg -> SKU: TAC1-A6).
It then:
  1. Resolves each SKU to its Shopify Product GID and Variant GID.
  2. Uploads the image to Shopify staged storage.
  3. Deletes old media from the product (to avoid duplicate accumulation).
  4. Creates the new product media and links it directly to the variant.

Usage:
    py update_image_by_sku.py --folder update_image
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

# Ensure UTF-8 console output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}

# ── 1. Staged upload to S3 ───────────────────────────────────────────────────
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

# ── 2. Get existing media IDs ────────────────────────────────────────────────
def get_media_ids(product_gid: str) -> list[str]:
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
    product_data = data.get("product")
    if not product_data:
        return []
    edges = product_data.get("media", {}).get("edges", [])
    return [e["node"]["id"] for e in edges]

# ── 3. Delete existing media ─────────────────────────────────────────────────
def delete_media(product_gid: str, media_ids: list[str]):
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
        print(f"  ⚠️ Delete old media errors: {result['userErrors']}")
    else:
        print(f"  🗑️ Deleted {len(result.get('deletedMediaIds', []))} old media")

# ── 4. Create new product media ──────────────────────────────────────────────
def create_media(product_gid: str, resource_url: str) -> str | None:
    mutation = """
    mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id status }
        userErrors { field message }
      }
    }"""
    media_input = [{"originalSource": resource_url, "mediaContentType": "IMAGE"}]
    body = gql(API_URL, HEADERS, mutation, {"productId": product_gid, "media": media_input})
    if not body:
        return None
    result = body.get("data", {}).get("productCreateMedia", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Create media errors: {result['userErrors']}")
        return None
    media_list = result.get("media", [])
    if media_list:
        new_media_id = media_list[0].get("id")
        print(f"  ✅ Created new product media: {new_media_id}")
        return new_media_id
    return None

# ── 5. Associate media with variant ──────────────────────────────────────────
def associate_media_to_variant(product_gid: str, variant_gid: str, media_id: str):
    mutation = """
    mutation variantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id }
        userErrors { field message }
      }
    }"""
    body = gql(API_URL, HEADERS, mutation, {
        "productId": product_gid,
        "variants": [{
            "id":      variant_gid,
            "mediaId": media_id
        }]
    })
    if not body:
        return
    result = body.get("data", {}).get("productVariantsBulkUpdate", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Variant association error: {result['userErrors']}")
    else:
        print(f"  🔗 Associated image with variant: {variant_gid}")

# ── 6. Batch resolve SKUs to Product GID & Variant GID ────────────────────────
def get_gids_by_skus(skus: list, batch_size: int = 50) -> dict:
    """Resolve SKUs in batch aliases. Returns { sku: { 'product_id': ..., 'variant_id': ... } }"""
    gid_map = {}
    total = len(skus)
    for i in range(0, total, batch_size):
        batch = skus[i:i + batch_size]
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

# ── Run Folder Update ────────────────────────────────────────────────────────
def run_update(folder_path: str):
    if not os.path.exists(folder_path):
        print(f"❌ Folder not found: {folder_path}")
        return

    # Scan for image files
    files = sorted([
        f for f in os.listdir(folder_path)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTS
    ])
    if not files:
        print(f"❌ No valid images found in folder: {folder_path}")
        return

    # Extract SKUs from filenames
    sku_to_file = {}
    for filename in files:
        sku = os.path.splitext(filename)[0]
        sku_to_file[sku] = os.path.join(folder_path, filename)

    skus = list(sku_to_file.keys())
    print(f"📂 Scanning folder: {folder_path}")
    print(f"📋 Found {len(skus)} SKUs from image filenames")

    print("\n🔍 Resolving SKUs on Shopify...")
    gid_map = get_gids_by_skus(skus)

    success = 0
    failed = 0

    for sku, file_path in sku_to_file.items():
        print(f"\n🔄 [{success+failed+1}/{len(skus)}] SKU: {sku}")
        gids = gid_map.get(sku)
        if not gids:
            print(f"  ⚠️ SKU '{sku}' not found on Shopify. Skipping.")
            failed += 1
            continue

        product_id = gids["product_id"]
        variant_id = gids["variant_id"]

        # 1. Upload local file → S3
        print(f"  ⬆️ Uploading: {os.path.basename(file_path)}")
        resourceUrl = staged_upload_image(file_path)
        if not resourceUrl:
            print("  ❌ Staged upload failed.")
            failed += 1
            continue

        # 2. Get and Delete existing media
        media_ids = get_media_ids(product_id)
        if media_ids:
            delete_media(product_id, media_ids)
            time.sleep(0.3)

        # 3. Create new media on the Product
        media_id = create_media(product_id, resourceUrl)
        if not media_id:
            print("  ❌ Failed to create product media.")
            failed += 1
            continue

        # 4. Associate the new media to the Variant
        time.sleep(0.3)
        associate_media_to_variant(product_id, variant_id, media_id)
        
        success += 1
        time.sleep(0.5)

    print(f"\n🎉 All done! Success: {success} | Failed: {failed}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update Shopify images using filename as SKU.")
    parser.add_argument("--folder", "-f", default="update_image", help="Folder containing images named as SKU.jpg")
    args = parser.parse_args()

    base_dir = os.path.dirname(__file__)
    folder = args.folder if os.path.isabs(args.folder) else os.path.join(base_dir, args.folder)

    run_update(folder)
