import requests
import pandas as pd
import time
import os
from dotenv import load_dotenv

load_dotenv()

SHOP  = os.getenv("SHOP_NAME")
TOKEN = os.getenv("SHOPIFY_ACCESS_TOKEN_IMPORT_PRODUCT")
print(f"SHOP: {SHOP}")
print(f"TOKEN: {TOKEN[:10]}..." if TOKEN else "TOKEN: None")

HEADERS = {"Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN}
API_URL = f"https://{SHOP}/admin/api/2026-01/graphql.json"


# ── Helper ────────────────────────────────────────────────────
def get_val(row, col):
    if col not in row.index:
        return None
    val = row[col]
    if pd.isna(val):
        return None
    return str(val).strip()


def gql(query, variables=None):
    """Execute GraphQL and return body dict."""
    res  = requests.post(API_URL, json={"query": query, "variables": variables or {}}, headers=HEADERS)
    body = res.json()
    if res.status_code != 200:
        print(f"  ❌ HTTP {res.status_code}: {body}")
        return None
    if body.get("errors"):
        print(f"  ❌ GraphQL errors: {body['errors']}")
        return None
    return body


# ── Step 1: Create Product ────────────────────────────────────
def create_product(row):
    input_data = {}

    if v := get_val(row, "Title"):           input_data["title"] = v
    if v := get_val(row, "Body (HTML)"):     input_data["descriptionHtml"] = v
    if v := get_val(row, "Vendor"):          input_data["vendor"] = v
    if v := get_val(row, "Type"):            input_data["productType"] = v
    if v := get_val(row, "Handle"):          input_data["handle"] = v
    if v := get_val(row, "Tags"):            input_data["tags"] = [t.strip() for t in v.split(",")]
    if v := get_val(row, "Status"):          input_data["status"] = v.upper()

    # productOptions (replaces old "options")
    options = []
    for i in ["1", "2", "3"]:
        name = get_val(row, f"Option{i} Name")
        val  = get_val(row, f"Option{i} Value")
        if name:
            opt = {"name": name}
            if val:
                opt["values"] = [{"name": v} for v in val.split(",")]
            options.append(opt)
    if options:
        input_data["productOptions"] = options

    mutation = """
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          handle
          options { id name values }
          variants(first: 1) { edges { node { id } } }
        }
        userErrors { field message }
      }
    }"""

    body = gql(mutation, {"input": input_data})
    if not body:
        return None

    result = body.get("data", {}).get("productCreate", {})
    if result.get("userErrors"):
        print(f"  ⚠️ userErrors: {result['userErrors']}")
        return None

    product = result.get("product")
    if not product:
        print(f"  ❌ No product in response: {body}")
        return None

    # Flatten default variant ID for convenience
    verts = product.get("variants", {}).get("edges", [])
    product["_default_variant_id"] = verts[0]["node"]["id"] if verts else None
    print(f"  ✅ Product created: {product.get('id')} | handle: {product.get('handle')}")
    return product


# ── Step 2: Create / Update Variant ─────────────────────────
def create_variant(product_id, product_options, row, default_variant_id=None):
    variant = {}

    if v := get_val(row, "Variant SKU"):   variant["inventoryItem"] = {"sku": v}
    if v := get_val(row, "Variant Price"): variant["price"] = v

    # Weight
    weight_val  = get_val(row, "Variant Grams")
    weight_unit = get_val(row, "Variant Weight Unit")
    unit_map    = {"kg": "KILOGRAMS", "g": "GRAMS", "lb": "POUNDS", "oz": "OUNCES"}
    if weight_val:
        variant["inventoryItem"] = variant.get("inventoryItem", {})
        variant["inventoryItem"]["measurement"] = {
            "weight": {
                "value": float(weight_val),
                "unit":  unit_map.get((weight_unit or "g").lower(), "GRAMS")
            }
        }

    if v := get_val(row, "Variant Inventory Policy"):
        variant["inventoryPolicy"] = v.upper()
    if v := get_val(row, "Variant Requires Shipping"):
        variant["inventoryItem"] = variant.get("inventoryItem", {})
        variant["inventoryItem"]["requiresShipping"] = v.lower() in ("true", "1", "yes")
    if v := get_val(row, "Variant Taxable"):
        variant["taxable"] = v.lower() in ("true", "1", "yes")

    # Map option values (values is [String!] so match by name)
    option_values = []
    for i, opt in enumerate(product_options, start=1):
        val = get_val(row, f"Option{i} Value")
        if val and val in (opt.get("values") or []):
            option_values.append({"optionId": opt["id"], "name": val})
    if option_values:
        variant["optionValues"] = option_values

    if default_variant_id:
        # Update the auto-created default variant instead of creating a new one
        mutation = """
        mutation variantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              sku
              inventoryItem { id }
            }
            userErrors { field message }
          }
        }"""
        variant["id"] = default_variant_id
        body = gql(mutation, {"productId": product_id, "variants": [variant]})
        if not body:
            return None
        result   = body.get("data", {}).get("productVariantsBulkUpdate", {})
        key_name = "updated"
    else:
        mutation = """
        mutation variantCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants {
              id
              sku
              inventoryItem { id }
            }
            userErrors { field message }
          }
        }"""
        body = gql(mutation, {"productId": product_id, "variants": [variant]})
        if not body:
            return None
        result   = body.get("data", {}).get("productVariantsBulkCreate", {})
        key_name = "created"

    if result.get("userErrors"):
        print(f"  ⚠️ Variant userErrors: {result['userErrors']}")
        return None

    variants = result.get("productVariants", [])
    if not variants:
        print(f"  ❌ No variant {key_name}: {body}")
        return None

    print(f"  ✅ Variant {key_name}: {variants[0].get('id')} | SKU: {variants[0].get('sku')}")
    return variants[0]


# ── Step 3: Add Images ────────────────────────────────────────
def add_images(product_id, row):
    v = get_val(row, "Image Src")
    if not v:
        return

    image_urls = [u.strip() for u in v.split(",") if u.strip()]
    media = [{"mediaContentType": "IMAGE", "originalSource": url} for url in image_urls]

    mutation = """
    mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id status } }
        mediaUserErrors { field message }
      }
    }"""

    body = gql(mutation, {"productId": product_id, "media": media})
    if not body:
        return

    result = body.get("data", {}).get("productCreateMedia", {})
    if result.get("mediaUserErrors"):
        print(f"  ⚠️ Image errors: {result['mediaUserErrors']}")
    else:
        print(f"  🖼️ Images queued: {len(image_urls)}")


# ── Step 4: Set Inventory ─────────────────────────────────────
def set_inventory(inventory_item_id, qty):
    # Get location
    loc_query = "{ locations(first: 1) { edges { node { id name } } } }"
    body = gql(loc_query)
    if not body:
        return

    loc_edges = body.get("data", {}).get("locations", {}).get("edges", [])
    if not loc_edges:
        print("  ⚠️ No location found")
        return

    location_id = loc_edges[0]["node"]["id"]
    print(f"  📍 Location: {loc_edges[0]['node']['name']}")

    mutation = """
    mutation inventorySet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }"""
    variables = {
        "input": {
            "name": "available",
            "reason": "correction",
            "quantities": [{
                "inventoryItemId": inventory_item_id,
                "locationId":      location_id,
                "quantity":        int(qty)
            }]
        }
    }

    body = gql(mutation, variables)
    if not body:
        return

    result = body.get("data", {}).get("inventorySetQuantities", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Inventory error: {result['userErrors']}")
    else:
        print(f"  📦 Inventory set: {qty}")


# ── Main ──────────────────────────────────────────────────────
if __name__ == "__main__":
    base_dir = os.path.dirname(__file__)
    CSV_FILE = os.path.join(base_dir, "test_create.csv")

    df = pd.read_csv(CSV_FILE)
    df.columns = df.columns.str.strip()
    print(f"Columns found: {df.columns.tolist()}")
    print(f"📋 {len(df)} rows to create")

    success     = 0
    failed      = 0
    failed_rows = []

    for idx, row in df.iterrows():
        title = get_val(row, "Title") or "(no title)"
        sku   = get_val(row, "Variant SKU") or "(no SKU)"
        print(f"\n🔄 [{idx+1}/{len(df)}] Creating: {title} | SKU: {sku}")

        # Step 1: Create product
        product = create_product(row)
        if not product:
            failed += 1
            failed_rows.append({"index": idx, "Title": title, "Variant SKU": sku})
            continue

        product_id         = product["id"]
        product_options    = product.get("options", [])
        default_variant_id = product.get("_default_variant_id")

        time.sleep(0.3)

        # Step 2: Update default variant (or create if none)
        variant = create_variant(product_id, product_options, row, default_variant_id)

        # Step 3: Add images
        time.sleep(0.3)
        add_images(product_id, row)

        # Step 4: Set inventory
        qty = get_val(row, "Variant Inventory Qty")
        if qty and variant:
            inventory_item_id = variant.get("inventoryItem", {}).get("id")
            if inventory_item_id:
                time.sleep(0.3)
                set_inventory(inventory_item_id, qty)

        success += 1
        time.sleep(0.5)

    if failed_rows:
        pd.DataFrame(failed_rows).to_csv("failed.csv", index=False)
        print(f"\n⚠️ {len(failed_rows)} failed rows → saved to failed.csv")

    print(f"\n🎉 Done! Created: {success} | Failed: {failed}")
