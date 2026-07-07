import sys
import os
import time
import requests
import mimetypes

# Set up paths to access utils
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
IMAGE_FOLDER = r"C:\Users\0125024\Pictures\image_product\merged_all_batches"
LIMIT = None # set to 5 for testing
DELETE_OLD_IMAGES = True # Set to True if we want to delete old images

QUERY_PRODUCT_BY_SKU = """
query($query: String!) {
  products(first: 1, query: $query) {
    edges {
      node {
        id
        title
        media(first: 10) {
          edges {
            node {
              id
              mediaContentType
            }
          }
        }
      }
    }
  }
}
"""

MUTATION_STAGED_UPLOAD = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters {
        name
        value
      }
    }
    userErrors {
      field
      message
    }
  }
}
"""

MUTATION_CREATE_MEDIA = """
mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media {
      id
      mediaContentType
      status
    }
    mediaUserErrors {
      field
      message
    }
  }
}
"""

MUTATION_DELETE_MEDIA = """
mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors {
      field
      message
    }
  }
}
"""

def upload_image_for_sku(sku, file_path):
    print(f"\nProcessing SKU: {sku}")
    
    # 1. Find Product ID
    res = gql(API_URL, HEADERS, QUERY_PRODUCT_BY_SKU, {"query": f"sku:{sku}"})
    edges = res.get("data", {}).get("products", {}).get("edges", [])
    if not edges:
        print(f"  ❌ Product not found for SKU: {sku}")
        return False
    
    product = edges[0]["node"]
    product_id = product["id"]
    print(f"  ✅ Found product: {product['title']} ({product_id})")
    
    # 2. Delete old media if required
    if DELETE_OLD_IMAGES:
        old_media_edges = product.get("media", {}).get("edges", [])
        old_media_ids = [e["node"]["id"] for e in old_media_edges]
        if old_media_ids:
            print(f"  🗑️ Deleting {len(old_media_ids)} old media items...")
            gql(API_URL, HEADERS, MUTATION_DELETE_MEDIA, {
                "productId": product_id,
                "mediaIds": old_media_ids
            })
    
    # 3. Create Staged Upload
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type: mime_type = "image/jpeg"
    filename = os.path.basename(file_path)
    
    upload_input = [{
        "resource": "IMAGE",
        "filename": filename,
        "mimeType": mime_type,
        "httpMethod": "POST"
    }]
    
    res = gql(API_URL, HEADERS, MUTATION_STAGED_UPLOAD, {"input": upload_input})
    data = res.get("data", {}).get("stagedUploadsCreate", {})
    if data.get("userErrors"):
        print(f"  ❌ stagedUploadsCreate error: {data['userErrors']}")
        return False
        
    target = data["stagedTargets"][0]
    upload_url = target["url"]
    resource_url = target["resourceUrl"]
    params = {p["name"]: p["value"] for p in target["parameters"]}
    
    # 4. HTTP POST the file
    print(f"  📤 Uploading file to Shopify staging...")
    with open(file_path, "rb") as f:
        # For multipart form data, the file must be the last field. requests handles this if we pass files=...
        response = requests.post(upload_url, data=params, files={"file": (filename, f, mime_type)})
    
    if response.status_code not in (200, 201, 204):
        print(f"  ❌ Failed to upload to AWS/GCP: HTTP {response.status_code} - {response.text}")
        return False
        
    # 5. Create Product Media
    print(f"  🔗 Attaching media to product...")
    media_input = [{
        "mediaContentType": "IMAGE",
        "originalSource": resource_url
    }]
    
    res = gql(API_URL, HEADERS, MUTATION_CREATE_MEDIA, {
        "productId": product_id,
        "media": media_input
    })
    
    errors = res.get("data", {}).get("productCreateMedia", {}).get("mediaUserErrors", [])
    if errors:
        print(f"  ❌ productCreateMedia error: {errors}")
        return False
        
    print(f"  ✅ Successfully added image to product!")
    return True

def main():
    if not os.path.exists(IMAGE_FOLDER):
        print(f"Image folder not found: {IMAGE_FOLDER}")
        return

    files = [f for f in os.listdir(IMAGE_FOLDER) if os.path.isfile(os.path.join(IMAGE_FOLDER, f))]
    print(f"Found {len(files)} files to upload.")
    
    if LIMIT:
        files = files[:LIMIT]
        print(f"Testing on first {LIMIT} files.")
        
    success_count = 0
    fail_count = 0
    
    for f in files:
        file_path = os.path.join(IMAGE_FOLDER, f)
        # SKU is filename without extension (and we might need to revert any safe filename transformations if they lost data, 
        # but normally the SKU is the exact filename. Wait, we replaced invalid chars with '_'. 
        # If the SKU in Shopify had '/', the filename has '_'. This might cause lookup to fail!
        # Let's hope SKUs don't have special chars or we can just try searching by the sanitized SKU.
        # Actually, Shopify SKU search uses `sku:XXX`. It might still match.
        sku, ext = os.path.splitext(f)
        
        try:
            if upload_image_for_sku(sku, file_path):
                success_count += 1
            else:
                fail_count += 1
        except Exception as e:
            print(f"  ❌ Exception: {e}")
            fail_count += 1
            
        time.sleep(0.5) # small delay to avoid rate limits
        
    print(f"\nFinished! Success: {success_count}, Failed: {fail_count}")

if __name__ == "__main__":
    main()
