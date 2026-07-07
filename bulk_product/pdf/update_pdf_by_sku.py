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

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
PDF_EXTS = {".pdf"}

# ── 1. Staged upload to S3 ───────────────────────────────────────────────────
STAGED_UPLOAD_MUTATION = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
"""

def staged_upload_file(file_path: str) -> dict | None:
    """Upload local file -> S3 -> return staged target info"""
    filename  = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    mime_type = mimetypes.guess_type(file_path)[0] or "application/pdf"

    body = gql(API_URL, HEADERS, STAGED_UPLOAD_MUTATION, {"input": [{
        "filename":   filename,
        "mimeType":   mime_type,
        "fileSize":   str(file_size),
        "httpMethod": "PUT",
        "resource":   "FILE",
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

    return target

# ── 2. Create File in Shopify ────────────────────────────────────────────────
FILE_CREATE_MUTATION = """
mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      ... on GenericFile { id url createdAt }
    }
    userErrors { field message }
  }
}
"""

def create_shopify_file(resource_url: str) -> str | None:
    """Register file in Shopify Files and return the CDN URL"""
    body = gql(API_URL, HEADERS, FILE_CREATE_MUTATION, {
        "files": [{"originalSource": resource_url, "contentType": "FILE"}]
    })
    if not body:
        return None

    errors = body.get("data", {}).get("fileCreate", {}).get("userErrors", [])
    if errors:
        print(f"  ⚠️ fileCreate error: {errors}")
        return None

    files = body["data"]["fileCreate"]["files"]
    if not files:
        return None

    file_id = files[0].get("id")
    url = files[0].get("url")
    
    if url:
        return url

    print(f"  ⏳ Waiting for Shopify to process the file (ID: {file_id})...")
    # Poll until URL is ready (up to 30 seconds)
    for _ in range(15):
        time.sleep(2)
        q = f'{{ node(id: "{file_id}") {{ ... on GenericFile {{ url }} }} }}'
        res = gql(API_URL, HEADERS, q)
        url = res.get("data", {}).get("node", {}).get("url")
        if url:
            return url
    
    print(f"  ⚠️ Timeout waiting for file URL")
    return None

# ── 3. Update Product Metafield ──────────────────────────────────────────────
METAFIELD_UPDATE_MUTATION = """
mutation productUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id }
    userErrors { field message }
  }
}
"""

def update_product_pdf_metafield(product_id: str, pdf_url: str):
    """Update custom.link_pdf metafield with the given URL"""
    input_data = {
        "id": product_id,
        "metafields": [
            {
                "namespace": "custom",
                "key": "link_pdf",
                "value": pdf_url,
                "type": "url"
            }
        ]
    }
    body = gql(API_URL, HEADERS, METAFIELD_UPDATE_MUTATION, {"input": input_data})
    if not body:
        return False
    
    errors = body.get("data", {}).get("productUpdate", {}).get("userErrors", [])
    if errors:
        print(f"  ⚠️ productUpdate error: {errors}")
        return False
    
    print(f"  ✅ Metafield custom.link_pdf updated: {pdf_url}")
    return True

# ── 4. Resolve SKUs ──────────────────────────────────────────────────────────
def get_gids_by_skus(skus: list, batch_size: int = 50) -> dict:
    gid_map = {}
    total = len(skus)
    for i in range(0, total, batch_size):
        batch = skus[i:i + batch_size]
        aliases = " ".join([
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") '
            f'{{ edges {{ node {{ product {{ id }} }} }} }}'
            for j, sku in enumerate(batch)
        ])
        body = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            if edges:
                node = edges[0]["node"]
                gid_map[sku] = node["product"]["id"]
            else:
                gid_map[sku] = None
        print(f"  Resolved {min(i + batch_size, total)}/{total} SKUs")
        time.sleep(0.5)
    return gid_map

# ── Main ─────────────────────────────────────────────────────────────────────
def run_update(folder_path: str):
    if not os.path.exists(folder_path):
        print(f"❌ Folder not found: {folder_path}")
        return

    files = sorted([
        f for f in os.listdir(folder_path)
        if os.path.splitext(f)[1].lower() in PDF_EXTS
    ])
    if not files:
        print(f"❌ No valid PDFs found in folder: {folder_path}")
        return

    sku_to_file = {}
    for filename in files:
        sku = os.path.splitext(filename)[0]
        sku_to_file[sku] = os.path.join(folder_path, filename)

    skus = list(sku_to_file.keys())
    print(f"📂 Scanning folder: {folder_path}")
    print(f"📋 Found {len(skus)} SKUs from PDF filenames")

    print("\\n🔍 Resolving SKUs on Shopify...")
    gid_map = get_gids_by_skus(skus)

    success = 0
    failed = 0

    for sku, file_path in sku_to_file.items():
        print(f"\\n🔄 [{success+failed+1}/{len(skus)}] SKU: {sku}")
        product_id = gid_map.get(sku)
        if not product_id:
            print(f"  ⚠️ SKU '{sku}' not found on Shopify. Skipping.")
            failed += 1
            continue

        print(f"  ⬆️ Uploading: {os.path.basename(file_path)}")
        target_info = staged_upload_file(file_path)
        if not target_info:
            failed += 1
            continue

        # Shopify API takes a brief moment to process S3 upload sometimes
        time.sleep(1)
        
        pdf_url = create_shopify_file(target_info["resourceUrl"])
        if not pdf_url:
            failed += 1
            continue

        if update_product_pdf_metafield(product_id, pdf_url):
            success += 1
        else:
            failed += 1
            
        time.sleep(0.5)

    print(f"\\n🎉 All done! Success: {success} | Failed: {failed}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload Shopify PDFs and link to custom.link_pdf by SKU.")
    parser.add_argument("--folder", "-f", required=True, help="Folder containing PDFs named as SKU.pdf")
    args = parser.parse_args()

    run_update(args.folder)
