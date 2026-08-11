
import os
import glob
import requests
import base64
from utils import gql as _gql, get_val, make_headers, API_URL

# Load .env if present
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

SHOP = os.environ.get("SHOP_NAME", "sevenfive-4062.myshopify.com")
TOKEN = os.environ.get("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT", "<YOUR_ADMIN_API_TOKEN>")

def get_product_id_by_sku(sku):
        query = '''
        query($sku: String!) {
            productVariants(first: 1, query: $sku) {
                edges { node { id product { id title handle legacyResourceId } } }
            }
        }
        '''
        variables = {"sku": f"sku:{sku}"}
        body = _gql(API_URL, {"X-Shopify-Access-Token": TOKEN}, query, variables)
        edges = body.get("data", {}).get("productVariants", {}).get("edges", [])
        if edges:
                # Return both GraphQL and REST product id
                return edges[0]["node"]["product"]["legacyResourceId"]
        return None

def add_image_to_product(product_id, image_path, sku):
    with open(image_path, "rb") as f:
        img_data = base64.b64encode(f.read()).decode()
    payload = {
        "image": {
            "attachment": img_data,
            "filename": os.path.basename(image_path),
            "alt": sku
        }
    }
    url = f"https://{SHOP}/admin/api/2024-01/products/{product_id}/images.json"
    headers = {"X-Shopify-Access-Token": TOKEN}
    resp = requests.post(url, json=payload, headers=headers)
    if resp.status_code in (200, 201):
        try:
            data = resp.json()
            if "image" in data:
                print(f"  🖼️ Image uploaded for product {product_id} | src: {data['image'].get('src')}")
            else:
                print(f"  ⚠️ Response: {data}")
        except Exception as e:
            print(f"  🖼️ Image uploaded for product {product_id} (no JSON details)")
    else:
        print(f"  ❌ Upload failed: {resp.status_code} {resp.text}")

def main(img_dir):
    img_files = glob.glob(os.path.join(img_dir, "*.jpg")) + glob.glob(os.path.join(img_dir, "*.jpeg")) + glob.glob(os.path.join(img_dir, "*.png"))
    print(f"Found {len(img_files)} image files.")
    for img_path in img_files:
        sku = os.path.splitext(os.path.basename(img_path))[0]
        print(f"Processing SKU: {sku} -> {img_path}")
        product_id = get_product_id_by_sku(sku)
        if not product_id:
            print(f"  ❌ No product found for SKU: {sku}")
            continue
        add_image_to_product(product_id, img_path, sku)

if __name__ == "__main__":
    import sys
    img_dir = sys.argv[1] if len(sys.argv) > 1 else "data/services"
    main(img_dir)
