import sys, os
import time
import mimetypes
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

# Add bulk_product to path to import utils
sys.path.insert(0, r"c:\Users\0125024\Documents\shoptify\bulk_product")
from utils import make_headers, gql, API_URL, get_product_gids_by_skus

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
FOLDER = r"c:\Users\0125024\Documents\shoptify\Web_Ready_PDFs"

STAGED_UPLOAD_MUTATION = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
"""

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

METAFIELD_UPDATE_MUTATION = """
mutation productUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id }
    userErrors { field message }
  }
}
"""

def staged_upload_file(file_path: str) -> dict | None:
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

    for attempt in range(3):
        try:
            with open(file_path, "rb") as f:
                resp = requests.put(target["url"], data=f, headers=hdrs, timeout=120)
            if resp.status_code in (200, 201):
                break
            print(f"  ⚠️ S3 PUT failed HTTP {resp.status_code}: {file_path}")
        except Exception as e:
            print(f"  ⚠️ S3 PUT exception: {e}")
            time.sleep(2)
    else:
        return None
    if resp.status_code not in (200, 201):
        print(f"  ⚠️ S3 PUT failed HTTP {resp.status_code}: {file_path}")
        return None

    return target

def create_shopify_file(resource_url: str) -> str | None:
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

    # Poll until URL is ready (up to 30 seconds)
    for _ in range(15):
        time.sleep(2)
        q = f'{{ node(id: "{file_id}") {{ ... on GenericFile {{ url }} }} }}'
        res = gql(API_URL, HEADERS, q)
        if not res: continue
        url = res.get("data", {}).get("node", {}).get("url")
        if url:
            return url
    
    print(f"  ⚠️ Timeout waiting for file URL")
    return None

def update_product_metafields(product_id: str, metafields: list[dict]):
    input_data = {
        "id": product_id,
        "metafields": metafields
    }
    body = gql(API_URL, HEADERS, METAFIELD_UPDATE_MUTATION, {"input": input_data})
    if not body: return False
    errors = body.get("data", {}).get("productUpdate", {}).get("userErrors", [])
    if errors:
        print(f"  ⚠️ productUpdate error: {errors}")
        return False
    return True

def process_sku(sku, product_id, pdfs):
    if not product_id:
        print(f"  ⚠️ SKU '{sku}' not found on Shopify.")
        return False

    metafields = []
    for metafield_key, file_path in pdfs.items():
        target_info = staged_upload_file(file_path)
        if not target_info:
            continue
        
        time.sleep(0.5)
        
        pdf_url = create_shopify_file(target_info["resourceUrl"])
        if not pdf_url:
            continue
            
        metafields.append({
            "namespace": "custom",
            "key": metafield_key,
            "value": pdf_url,
            "type": "url"
        })
        
    if not metafields:
        return False

    if update_product_metafields(product_id, metafields):
        print(f"  ✅ SKU {sku} updated with {len(metafields)} metafield(s)")
        return True
    return False

def main():
    category_map = {
        "Spec Sheet": "link_pdf",
        "Datasheet": "datasheet",
        "User Manual": "user_manual"
    }

    sku_data = {}
    
    print(f"📂 Scanning folder: {FOLDER}")
    
    skip_skus = set()
    try:
        with open(r"c:\Users\0125024\Documents\shoptify\success_skus.txt", "r", encoding="utf-8") as f:
            skip_skus = {line.strip() for line in f if line.strip()}
        print(f"⏭️ Skipping {len(skip_skus)} already successful SKUs")
    except Exception as e:
        pass

    for sku_dir in os.listdir(FOLDER):
        if sku_dir in skip_skus:
            continue
            
        sku_path = os.path.join(FOLDER, sku_dir)
        if not os.path.isdir(sku_path): continue
        
        pdfs = {}
        for cat, m_key in category_map.items():
            cat_path = os.path.join(sku_path, cat)
            if os.path.isdir(cat_path):
                for f in os.listdir(cat_path):
                    if f.lower().endswith('.pdf'):
                        pdfs[m_key] = os.path.join(cat_path, f)
                        break # Only take the first pdf in that category folder
                        
        if pdfs:
            sku_data[sku_dir] = pdfs

    if not sku_data:
        print("❌ No valid PDFs found.")
        return

    print(f"📋 Found PDFs for {len(sku_data)} SKUs.")
    print("🔍 Resolving SKUs on Shopify...")
    gid_map = get_product_gids_by_skus(API_URL, HEADERS, list(sku_data.keys()))

    success = 0
    failed = 0

    print("🚀 Starting uploads...")
    with ThreadPoolExecutor(max_workers=5) as ex:
        futures = []
        for sku, pdfs in sku_data.items():
            product_id = gid_map.get(sku)
            futures.append(ex.submit(process_sku, sku, product_id, pdfs))
            
        for future in as_completed(futures):
            if future.result():
                success += 1
            else:
                failed += 1

    print(f"\\n🎉 All done! Success: {success} | Failed: {failed}")

if __name__ == "__main__":
    main()
