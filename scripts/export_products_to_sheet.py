"""
Shopify Product Exporter to Google Sheets via Python & gspread
Designed for high performance (40,000+ rows in ~15 seconds) & GitHub Actions Cloud execution.
"""

import os
import sys
import json
import time
import requests
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

# Headers list for exported sheet
EXPORT_HEADERS = [
    "custom.good_id",
    "Variant SKU",
    "Product GID",
    "Variant GID",
    "Inventory Item ID",
    "Handle",
    "Title",
    "Vendor",
    "Type",
    "Tags",
    "Status",
    "Published",
    "Price",
    "Compare At Price",
    "Inventory",
    "Image Src",
    "custom.spapart_or_product"
]

INNER_QUERY = """
{
  products {
    edges {
      node {
        id
        handle
        title
        vendor
        productType
        tags
        status
        publishedAt
        variants {
          edges {
            node {
              id
              sku
              price
              compareAtPrice
              inventoryQuantity
              inventoryItem { id }
            }
          }
        }
        images(first: 1) {
          edges {
            node {
              id
              url
            }
          }
        }
        metafields {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  }
}
"""

BULK_MUTATION = """
mutation BulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status url }
    userErrors { field message }
  }
}
"""

POLL_QUERY = """
query GetBulkOperation($id: ID!) {
  node(id: $id) {
    ... on BulkOperation {
      id
      status
      errorCode
      objectCount
      url
    }
  }
}
"""

CHECK_CURRENT_QUERY = """
{ currentBulkOperation(type: QUERY) { id status url } }
"""

def run_export():
    client = ShopifyClient()
    print("🔍 Checking active/completed bulk operations on Shopify...")
    
    check_res = client.gql(CHECK_CURRENT_QUERY)
    current_op = check_res.get("data", {}).get("currentBulkOperation") if check_res else None
    
    download_url = None
    op_id = None
    
    if current_op and current_op.get("status") == "COMPLETED" and current_op.get("url"):
        print(f"✅ Found completed bulk operation: {current_op['id']}")
        download_url = current_op["url"]
    elif current_op and current_op.get("status") in ("RUNNING", "CREATED"):
        print(f"⏳ Found active bulk operation: {current_op['id']}")
        op_id = current_op["id"]
    else:
        print("🚀 Starting new bulk operation on Shopify...")
        start_res = client.gql(BULK_MUTATION, {"query": INNER_QUERY})
        op_data = start_res.get("data", {}).get("bulkOperationRunQuery", {}) if start_res else {}
        user_errors = op_data.get("userErrors", [])
        if user_errors:
            print(f"❌ User Errors: {user_errors}")
            sys.exit(1)
        
        op_id = op_data.get("bulkOperation", {}).get("id")
        if not op_id:
            print("❌ Failed to start bulk query.")
            sys.exit(1)
        print(f"✅ Bulk operation started: {op_id}")
    
    # Poll until complete if not completed yet
    if not download_url:
        print("⏳ Polling bulk operation status...")
        while True:
            poll_res = client.gql(POLL_QUERY, {"id": op_id})
            node = poll_res.get("data", {}).get("node", {}) if poll_res else {}
            status = node.get("status")
            count = node.get("objectCount", 0)
            print(f"  [{status}] {count} objects processed...")
            
            if status == "COMPLETED":
                download_url = node.get("url")
                break
            elif status in ("FAILED", "CANCELED"):
                print(f"❌ Bulk operation failed: {node.get('errorCode')}")
                sys.exit(1)
            
            time.sleep(5)
            
    print("📥 Downloading JSONL data from Shopify...")
    resp = requests.get(download_url, stream=True)
    resp.raise_for_status()
    
    products = {}
    variants = {}
    meta = {}
    product_images = {}
    total_lines = 0
    
    for line in resp.iter_lines():
        if not line:
            continue
        total_lines += 1
        try:
            obj = json.loads(line.decode('utf-8'))
            gid = obj.get("id", "")
            parent = obj.get("__parentId", "")
            
            if "/Product/" in gid and not parent:
                products[gid] = obj
            elif "/ProductVariant/" in gid and parent:
                if parent not in variants:
                    variants[parent] = []
                variants[parent].append(obj)
            elif ("/ProductImage/" in gid or "/Image/" in gid) and parent:
                if parent not in product_images:
                    product_images[parent] = []
                product_images[parent].append(obj.get("url", ""))
            elif obj.get("namespace") and obj.get("key") and parent:
                if parent not in meta:
                    meta[parent] = {}
                meta[parent][f"{obj['namespace']}.{obj['key']}"] = obj.get("value")
        except Exception:
            pass
            
    print(f"  Parsed {total_lines} JSONL lines.")
    
    # Assemble 2D Rows
    all_rows = []
    for pid, p in products.items():
        mf = meta.get(pid, {})
        p_variants = variants.get(pid, [{}])
        p_imgs = product_images.get(pid, [])
        
        for v in p_variants:
            vid = v.get("id", "")
            inv = v.get("inventoryItem", {}).get("id", "") if v.get("inventoryItem") else ""
            vmf = meta.get(vid, {})
            
            row_obj = {
                "Variant SKU": v.get("sku", "") or "",
                "Product GID": pid,
                "Variant GID": vid,
                "Inventory Item ID": inv,
                "Handle": p.get("handle", "") or "",
                "Title": p.get("title", "") or "",
                "Vendor": p.get("vendor", "") or "",
                "Type": p.get("productType", "") or "",
                "Tags": ", ".join(p.get("tags", [])),
                "Status": p.get("status", "") or "",
                "Published": "TRUE" if p.get("publishedAt") else "FALSE",
                "Price": v.get("price") if v.get("price") is not None else "",
                "Compare At Price": v.get("compareAtPrice") if v.get("compareAtPrice") is not None else "",
                "Inventory": v.get("inventoryQuantity") if v.get("inventoryQuantity") is not None else "",
                "Image Src": p_imgs[0] if p_imgs else ""
            }
            row_obj.update(mf)
            row_obj.update(vmf)
            
            good_id = row_obj.get("custom.good_id")
            if good_id is not None and good_id != "":
                try:
                    row_obj["custom.good_id"] = int(good_id)
                except ValueError:
                    row_obj["custom.good_id"] = ""
            else:
                row_obj["custom.good_id"] = ""
                
            if "custom.spapart_or_product" not in row_obj or row_obj["custom.spapart_or_product"] is None:
                row_obj["custom.spapart_or_product"] = ""
                
            all_rows.append(row_obj)
            
    final_rows_2d = [EXPORT_HEADERS]
    for row in all_rows:
        final_rows_2d.append([row.get(h, "") if row.get(h) is not None else "" for h in EXPORT_HEADERS])
        
    print(f"📊 Assembled {len(all_rows)} variant rows.")
    
    # Push to Google Sheet using gspread
    update_google_sheet(final_rows_2d)

def update_google_sheet(rows_2d):
    webapp_url = os.getenv("WEBAPP_URL") or os.getenv("APPS_SCRIPT_WEBAPP_URL")
    
    if webapp_url:
        print("🌐 Sending data to Google Apps Script WebApp in 2,000-row chunks...")
        CHUNK_SIZE = 2000
        total_rows = len(rows_2d)
        total_chunks = (total_rows + CHUNK_SIZE - 1) // CHUNK_SIZE
        
        for i in range(0, total_rows, CHUNK_SIZE):
            chunk_rows = rows_2d[i : i + CHUNK_SIZE]
            action = "overwrite" if i == 0 else "append"
            chunk_num = (i // CHUNK_SIZE) + 1
            
            print(f"  📤 Sending chunk {chunk_num}/{total_chunks} ({len(chunk_rows)} rows)...")
            
            for attempt in range(3):
                try:
                    res = requests.post(
                        webapp_url,
                        json={"rows": chunk_rows, "action": action},
                        timeout=180
                    )
                    if res.status_code == 200:
                        try:
                            res_data = res.json()
                            if res_data.get("status") == "success":
                                break
                            else:
                                print(f"  ❌ Apps script error: {res_data.get('message')}")
                        except Exception:
                            print(f"  ✅ Chunk {chunk_num} sent successfully.")
                            break
                    else:
                        print(f"  ❌ Failed HTTP {res.status_code}: {res.text[:100]}")
                except Exception as e:
                    print(f"  ⚠️ Chunk {chunk_num} attempt {attempt + 1}/3 timed out: {e}")
                    time.sleep(2)
            else:
                print(f"❌ Failed to send chunk {chunk_num} to Apps Script after 3 attempts.")
                sys.exit(1)

        print(f"✅ Successfully exported {total_rows - 1} products to Google Sheet!")
        return

    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    sheet_name = os.getenv("EXPORT_SHEET_NAME", "Products Export")
    service_account_json = os.getenv("GCP_SERVICE_ACCOUNT_KEY")
    
    if not sheet_id:
        print("❌ Error: WEBAPP_URL or GOOGLE_SHEET_ID environment variable must be set.")
        sys.exit(1)
        
    try:
        import gspread
    except ImportError:
        print("❌ gspread is required. Install via pip install gspread")
        sys.exit(1)
        
    if service_account_json:
        if service_account_json.strip().startswith("{"):
            gc = gspread.service_account_from_dict(json.loads(service_account_json))
        else:
            gc = gspread.service_account(filename=service_account_json)
    else:
        creds_file = PROJECT_ROOT / "google_credentials.json"
        if creds_file.exists():
            gc = gspread.service_account(filename=str(creds_file))
        else:
            print("❌ Google credentials not found. Provide WEBAPP_URL or GCP_SERVICE_ACCOUNT_KEY.")
            sys.exit(1)
            
    print(f"📄 Opening Google Sheet (ID: {sheet_id})...")
    sh = gc.open_by_key(sheet_id)
    
    try:
        ws = sh.worksheet(sheet_name)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=sheet_name, rows=len(rows_2d)+100, cols=len(EXPORT_HEADERS)+5)
        
    print("🧹 Clearing old data and updating sheet...")
    ws.clear()
    ws.update(rows_2d, value_input_option="USER_ENTERED")
    print(f"✅ Successfully exported {len(rows_2d)-1} products to Google Sheet!")

if __name__ == "__main__":
    run_export()
