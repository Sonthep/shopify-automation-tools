import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import argparse
import os
import requests
import pandas as pd
import time
import os
import argparse
from utils import make_headers, gql as _gql, get_val as _get_val, read_csv_auto, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")


# ── Helper wrappers (delegate to utils) ───────────────────────
def get_val(row, col):
    return _get_val(row, col)


def gql(query, variables=None):
    return _gql(API_URL, HEADERS, query, variables)


def build_metafields(row):
    standard_cols = {
        "Handle", "Title", "Title TH", "Body (HTML)", "Body (HTML) TH",
        "Vendor", "Type", "Tags", "Status", "Published",
        "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value",
        "Option3 Name", "Option3 Value", "Variant SKU", "Variant Price",
        "Variant Grams", "Variant Weight Unit", "Variant Inventory Policy",
        "Variant Requires Shipping", "Variant Taxable", "Variant Inventory Qty",
        "Variant Compare At Price", "Variant Barcode", "Image Src",
        "Image Position", "Image Alt Text", "Gift Card", "SEO Title",
        "SEO Description", "Sales Channels", "Published Channels"
    }
    metafields = []
    for col in row.index:
        if col in standard_cols:
            continue
        raw = get_val(row, col)
        if not raw:
            continue

        namespace = None
        key = None
        if "." in col:
            namespace, key = col.split(".", 1)
        elif "_" in col:
            namespace, key = col.split("_", 1)

        if not namespace or not key:
            continue

        namespace = namespace.strip()
        key = key.strip()
        if not namespace or not key:
            continue

        metafields.append({
            "namespace": namespace,
            "key": key,
            "value": raw,
            "type": "single_line_text_field",
        })
    return metafields


# ── Step 1: Create Product ────────────────────────────────────
def create_product(row, sku=""):
    input_data = {}

    title_eng = get_val(row, "Title")
    title_th  = get_val(row, "Title TH")
    if title_eng:
        input_data["title"] = title_eng
    elif title_th:
        input_data["title"] = title_th

    body_eng = get_val(row, "Body (HTML)")
    body_th  = get_val(row, "Body (HTML) TH")
    if body_eng:
        input_data["descriptionHtml"] = body_eng
    elif body_th:
        input_data["descriptionHtml"] = body_th

    if v := get_val(row, "Vendor"):          input_data["vendor"] = v
    if v := get_val(row, "Type"):            input_data["productType"] = v
    if v := get_val(row, "Handle"):          input_data["handle"] = v
    if v := get_val(row, "Tags"):            input_data["tags"] = [t.strip() for t in v.split(",")]
    if v := get_val(row, "Status"):          input_data["status"] = v.upper()

    metafields = build_metafields(row)
    if metafields:
        input_data["metafields"] = metafields

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

    if metafields := build_metafields(row):
        input_data["metafields"] = metafields

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
        errors = result["userErrors"]
        handle_conflict = any(
            "handle" in str(e.get("field", "")) and "already in use" in e.get("message", "")
            for e in errors
        )
        if handle_conflict and sku and "handle" in input_data:
            safe_sku = sku.lower().replace("/", "-").replace(".", "-")
            new_handle = f"{input_data['handle']}-{safe_sku}"
            input_data["handle"] = new_handle
            print(f"  🔁 Handle conflict → retry with: {new_handle}")
            body = gql(mutation, {"input": input_data})
            if not body:
                return None
            result = body.get("data", {}).get("productCreate", {})
            if result.get("userErrors"):
                print(f"  ❌ Retry failed: {result['userErrors']}")
                return None
        else:
            print(f"  ⚠️ userErrors: {errors}")
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


def get_translatable_digests(resource_id):
    query = """
    query translatableResource($resourceId: ID!) {
      translatableResource(resourceId: $resourceId) {
        translatableContent { key digest }
      }
    }"""

    body = gql(query, {"resourceId": resource_id})
    if not body:
        print("  ❌ Could not fetch translation digests")
        return {}

    resource = body.get("data", {}).get("translatableResource")
    if not resource:
        print("  ⚠️ No translatableResource returned")
        return {}

    return {
        entry["key"]: entry["digest"]
        for entry in resource.get("translatableContent", [])
        if entry.get("key") and entry.get("digest")
    }


def register_thai_translations(product_id, row):
    translations = []
    if v := get_val(row, "Title TH"):
        translations.append({"key": "title", "value": v, "locale": "th"})
    if v := get_val(row, "Body (HTML) TH"):
        translations.append({"key": "body_html", "value": v, "locale": "th"})
    if not translations:
        return

    digests = get_translatable_digests(product_id)
    print(f"  🔎 Translation digests: {list(digests.keys())}")

    safe_translations = []
    for translation in translations:
        digest = digests.get(translation["key"])
        if digest:
            safe_translations.append({**translation, "translatableContentDigest": digest})
        else:
            print(f"  ⚠️ No digest for translation key: {translation['key']}")

    if not safe_translations:
        print("  ⚠️ No valid Thai translations to register")
        return

    mutation = """
    mutation translationRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
      translationsRegister(resourceId: $resourceId, translations: $translations) {
        translations { key locale }
        userErrors { field message }
      }
    }"""

    body = gql(mutation, {"resourceId": product_id, "translations": safe_translations})
    if not body:
        print("  ❌ No response from translation API")
        return

    if errors := body.get("errors"):
        print(f"  ❌ Translation GraphQL errors: {errors}")
        return

    result = body.get("data", {}).get("translationsRegister", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Translation userErrors: {result['userErrors']}")
        return

    print(f"  🈴 Thai translations registered: {[t['key'] for t in safe_translations]}")


# ── Step 2: Create / Update Variant ─────────────────────────
def create_variant(product_id, product_options, row, default_variant_id=None):
    variant = {}

    if v := get_val(row, "Variant SKU"):   variant["inventoryItem"] = {"sku": v}
    if v := get_val(row, "Variant Price"): variant["price"] = v
    if v := get_val(row, "Variant Compare At Price"): variant["compareAtPrice"] = v

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


# ── Step 3: Publish to Sales Channels ────────────────────────
_publication_map_cache = None
_location_id_cache = None

def get_publication_map():
    global _publication_map_cache
    if _publication_map_cache is not None:
        return _publication_map_cache

    query = "{ publications(first: 50) { edges { node { id name } } } }"
    body = gql(query)
    if not body:
        return {}

    publication_edges = body.get("data", {}).get("publications", {}).get("edges", [])
    pub_map = {
        edge["node"]["name"].strip().lower(): edge["node"]["id"]
        for edge in publication_edges
        if edge.get("node", {}).get("id") and edge.get("node", {}).get("name")
    }
    _publication_map_cache = pub_map
    names = [edge["node"].get("name") for edge in publication_edges if edge.get("node", {}).get("name")]
    print(f"  📡 Publications found: {len(pub_map)} | {names}")
    return pub_map


def publish_product(product_id, target_channels=None):
    pub_map = get_publication_map()
    if not pub_map:
        print("  ⚠️ No publications found to publish to")
        return

    # Default to the 3 channels: Online Store, Point of Sale, Inbox (excludes NTS Storefront)
    if target_channels is None:
        target_channels = ["Online Store", "Point of Sale", "Inbox"]

    target_ids = []
    selected_names = []
    for ch in target_channels:
        ch_lower = ch.strip().lower()
        if ch_lower in pub_map:
            target_ids.append(pub_map[ch_lower])
            selected_names.append(ch.strip())

    if not target_ids:
        print(f"  ⚠️ No matching publication IDs for channels: {target_channels}")
        return

    mutation = """
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id } }
        userErrors { field message }
      }
    }"""
    variables = {
        "id":    product_id,
        "input": [{"publicationId": pid} for pid in target_ids],
    }
    body = gql(mutation, variables)
    if not body:
        return

    result = body.get("data", {}).get("publishablePublish", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Publish errors: {result['userErrors']}")
    else:
        print(f"  🟢 Published to {len(target_ids)} channel(s): {', '.join(selected_names)}")


# ── Step 4: Add Images ────────────────────────────────────────
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


def get_translatable_digests(resource_id: str) -> dict:
    query = f"""
    query {{
      translatableResource(resourceId: \"{resource_id}\") {{
        translatableContent {{ key digest }}
      }}
    }}"""
    body = gql(query)
    if not body:
        return {}
    data = body.get("data", {})
    resource = data.get("translatableResource")
    if not resource:
        return {}
    return {item["key"]: item["digest"] for item in resource.get("translatableContent", [])}


def register_translation(resource_id: str, key: str, value: str, locale: str = "th", digest: str | None = None) -> bool:
    if not digest:
        return False
    mutation = """
    mutation RegisterTranslation($resourceId: ID!, $input: TranslationInput!) {
      translationsRegister(resourceId: $resourceId, translations: [$input]) {
        translations { key locale }
        userErrors { field message }
      }
    }"""
    variables = {
        "resourceId": resource_id,
        "input": {
            "key":                       key,
            "value":                     value,
            "locale":                    locale,
            "translatableContentDigest": digest,
        },
    }
    body = gql(mutation, variables)
    if not body:
        return False
    result = body.get("data", {}).get("translationsRegister", {})
    if result.get("userErrors"):
        print(f"  ⚠️ Translation error for {key}: {result['userErrors']}")
        return False
    return True


def create_thai_translations(resource_id: str, row) -> int:
    translation_map = {
        "title":           get_val(row, "Title_TH"),
        "body_html":       get_val(row, "description_th"),
        "meta_title":      get_val(row, "meta_title"),
        "meta_description": get_val(row, "meta_description"),
    }
    translations = {
        key: str(value).strip()
        for key, value in translation_map.items()
        if value and str(value).strip()
    }
    if not translations:
        return 0

    digests = get_translatable_digests(resource_id)
    if not digests:
        print(f"  ⚠️ Cannot fetch translation digests for {resource_id}")
        return 0

    count = 0
    for key, value in translations.items():
        digest = digests.get(key)
        if not digest:
            print(f"  ⚠️ No digest for translation key '{key}' on {resource_id}")
            continue
        if register_translation(resource_id, key, value, locale="th", digest=digest):
            print(f"  ✅ Registered Thai translation for {key}")
            count += 1
    return count


# ── Step 4: Set Inventory ─────────────────────────────────────
def set_inventory(inventory_item_id, qty):
    global _location_id_cache
    # Get location (cached — only fetched once)
    if _location_id_cache is None:
        loc_query = "{ locations(first: 1) { edges { node { id name } } } }"
        body = gql(loc_query)
        if not body:
            return
        loc_edges = body.get("data", {}).get("locations", {}).get("edges", [])
        if not loc_edges:
            print("  ⚠️ No location found")
            return
        _location_id_cache = loc_edges[0]["node"]["id"]
        print(f"  📍 Location: {loc_edges[0]['node']['name']}")
    location_id = _location_id_cache

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
    parser = argparse.ArgumentParser(description="Create Shopify products from CSV.")
    parser.add_argument("csv_pos", nargs="*", help="CSV file path (positional)")
    parser.add_argument("--csv", default="", help="Path to CSV file relative to script directory")
    parser.add_argument("--lang", choices=["EN", "TH", "BOTH"], default="EN", help="Prefer Title/description language or BOTH")
    parser.add_argument("--dry-run", action="store_true", help="Print mapping only; don't call Shopify API")
    args = parser.parse_args()

    base_dir = os.path.dirname(__file__)
    if args.csv_pos:
        CSV_FILE = " ".join(args.csv_pos)
    elif args.csv:
        CSV_FILE = os.path.join(base_dir, args.csv) if not os.path.isabs(args.csv) else args.csv
    else:
        CSV_FILE = os.path.join(base_dir, "data", "test_create.csv")
        if not os.path.exists(CSV_FILE):
            CSV_FILE = os.path.join(base_dir, "test_create.csv")
    title_lang = args.lang
    dry_run = args.dry_run

    df = read_csv_auto(CSV_FILE)
    df.columns = df.columns.str.strip()
    print(f"CSV file: {CSV_FILE}")
    print(f"Columns found: {df.columns.tolist()}")
    print(f"📋 {len(df)} rows to create")

    # Map common incoming column names to the script's expected columns
    rename_map = {
        "SKU": "Variant SKU",
        "price": "Variant Price",
        "Price": "Variant Price",
        "qty": "Variant Inventory Qty",
        "URL handle": "Handle",
        "URL Handle": "Handle",
        "Product image URL": "Image Src",
        "Product Image URL": "Image Src",
        "Image position": "Image position",
        # keep Title_EN/Title_TH and description_en/description_th for language selection
        "Title_EN": "Title_EN",
        "Title_TH": "Title_TH",
        "description_en": "description_en",
        "description_th": "description_th",
    }
    df = df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns})

    # Build Title and Body (HTML) based on preferred language
    def pick_series(preferred, fallback=None):
        if preferred in df.columns:
            return df[preferred].fillna("")
        if fallback and fallback in df.columns:
            return df[fallback].fillna("")
        if preferred in ("Title_EN", "Title_TH") and "Title" in df.columns:
            return df["Title"].fillna("")
        if preferred in ("description_en", "description_th") and "Body (HTML)" in df.columns:
            return df["Body (HTML)"].fillna("")
        return pd.Series([""] * len(df))

    if title_lang == "TH":
        df["Title"] = pick_series("Title_TH", "Title_EN")
        df["Body (HTML)"] = pick_series("description_th", "description_en")
    else:
        df["Title"] = pick_series("Title_EN", "Title_TH")
        df["Body (HTML)"] = pick_series("description_en", "description_th")

    success = 0
    failed = 0
    failed_rows = []

    for idx, row in df.iterrows():
        title = get_val(row, "Title") or "(no title)"
        sku   = get_val(row, "Variant SKU") or ""
        print(f"\n🔄 [{idx+1}/{len(df)}] Creating: {title} | SKU: {sku or '(no SKU)'}")

        # Dry-run preview: don't call Shopify when requested
        if dry_run:
            payload_preview = {
                "title": get_val(row, "Title"),
                "descriptionHtml": get_val(row, "Body (HTML)"),
                "handle": get_val(row, "Handle"),
                "variant_sku": get_val(row, "Variant SKU"),
                "variant_price": get_val(row, "Variant Price"),
                "inventory_qty": get_val(row, "Variant Inventory Qty"),
                "images": get_val(row, "Image Src"),
                "metafields": build_metafields(row),
            }
            print(f"  🧾 DRY RUN preview: {payload_preview}")
            continue

        # Step 1: Create product
        product = create_product(row, sku=sku)
        if not product:
            failed += 1
            failed_rows.append({"index": idx, "Title": title, "Variant SKU": sku})
            continue

        product_id         = product["id"]
        if title_lang == "BOTH":
            translations_created = create_thai_translations(product_id, row)
            if translations_created:
                print(f"  🈶 Thai translations created: {translations_created}")

        product_options    = product.get("options", [])
        default_variant_id = product.get("_default_variant_id")

        # Step 2: Update default variant (or create if none)
        variant = create_variant(product_id, product_options, row, default_variant_id)

        # Step 2b: Register Thai translations if provided
        register_thai_translations(product_id, row)

        # Step 3: Publish to target channels (Online Store, Point of Sale, Inbox)
        channels_val = get_val(row, "Sales Channels") or get_val(row, "Published Channels")
        target_channels = [c.strip() for c in channels_val.split(",") if c.strip()] if channels_val else ["Online Store", "Point of Sale", "Inbox"]
        publish_product(product_id, target_channels=target_channels)

        # Step 4: Add images
        add_images(product_id, row)

        # Step 5: Set inventory
        qty = get_val(row, "Variant Inventory Qty")
        if qty and variant:
            inventory_item_id = variant.get("inventoryItem", {}).get("id")
            if inventory_item_id:
                set_inventory(inventory_item_id, qty)

        success += 1
        time.sleep(0.5)  # ป้องกัน rate limit (Shopify: 2 req/s)

    if failed_rows:
        pd.DataFrame(failed_rows).to_csv("failed.csv", index=False)
        print(f"\n⚠️ {len(failed_rows)} failed rows → saved to failed.csv")

    print(f"\n🎉 Done! Created: {success} | Failed: {failed}")
