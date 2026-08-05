"""
update_image_cat.py (update_image_collection.py)
Update Shopify Collection header/category images from a local folder of images.

Matches image filenames (e.g. Bakery-Equipment.jpg) to Shopify Collections by:
  1. Alias map (e.g. Refrigerator-Equipment -> refrigeration-equipment)
  2. Handle (exact or normalized slug e.g. 'bakery-equipment')
  3. Title (e.g. 'Bakery Equipment')
  4. Cleaned alphanumeric name (e.g. 'bakeryequipment')

Default folder:
  C:\\Users\\0125024\\Downloads\\Category_EN_Renamed

Usage:
    py update_image_cat.py --dry-run                     # Preview matches without uploading
    py update_image_cat.py                               # Perform actual update
    py update_image_cat.py --folder "C:\\path\\to\\folder" # Custom folder path
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import os
import sys
import re
import time
import argparse
import mimetypes
import requests
import pandas as pd

from utils import make_headers, gql, API_URL

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HEADERS      = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
IMAGE_EXTS   = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}
DEFAULT_DIR  = r"C:\Users\0125024\Downloads\Category_EN_Renamed"

# Explicit alias mapping for filenames with variations in handle naming
ALIAS_MAP = {
    "refrigerator-equipment": "refrigeration-equipment",
    "refrigerator_equipment": "refrigeration-equipment",
    "spare-part":             "spapart",
    "spare_part":             "spapart",
    "spare-parts":            "spapart",
    "storage-transportation": "storage-transport",
    "storage_transportation": "storage-transport",
    "tabletop-buffetware":    "tableware-buffetware",
    "tabletop_buffetware":    "tableware-buffetware",
}

# ── GraphQL Queries & Mutations ───────────────────────────────

GET_COLLECTIONS_QUERY = """
query getCollections($cursor: String) {
  collections(first: 250, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        title
        handle
        image {
          id
          url
        }
      }
    }
  }
}
"""

STAGED_UPLOAD_MUTATION = """
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

COLLECTION_UPDATE_MUTATION = """
mutation collectionUpdate($input: CollectionInput!) {
  collectionUpdate(input: $input) {
    collection {
      id
      title
      handle
      image {
        id
        url
      }
    }
    userErrors {
      field
      message
    }
  }
}
"""


# ── Helpers ───────────────────────────────────────────────────

def normalize_name(name: str) -> str:
    """Normalize string for fuzzy matching (remove non-alphanumeric, lowercase)."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def fetch_all_collections() -> list[dict]:
    """Fetch all collections from Shopify with pagination."""
    print("[Shopify] Fetching all collections...")
    collections = []
    cursor = None
    has_next = True

    while has_next:
        res = gql(API_URL, HEADERS, GET_COLLECTIONS_QUERY, {"cursor": cursor})
        if not res or "data" not in res:
            print("  ❌ Failed to fetch collections")
            break

        data = res["data"]["collections"]
        for edge in data["edges"]:
            collections.append(edge["node"])

        has_next = data["pageInfo"]["hasNextPage"]
        cursor   = data["pageInfo"]["endCursor"]

    print(f"[Shopify] Found {len(collections)} total collections.")
    return collections


def staged_upload_collection_image(file_path: str) -> str | None:
    """Upload local image file to S3 via stagedUploadsCreate, return resourceUrl."""
    filename  = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    mime_type = mimetypes.guess_type(file_path)[0] or "image/jpeg"

    for resource_type in ("COLLECTION_IMAGE", "IMAGE"):
        body = gql(API_URL, HEADERS, STAGED_UPLOAD_MUTATION, {"input": [{
            "filename":   filename,
            "mimeType":   mime_type,
            "fileSize":   str(file_size),
            "httpMethod": "PUT",
            "resource":   resource_type,
        }]})
        if not body:
            continue

        errors = body.get("data", {}).get("stagedUploadsCreate", {}).get("userErrors", [])
        if errors:
            continue

        staged_targets = body.get("data", {}).get("stagedUploadsCreate", {}).get("stagedTargets", [])
        if staged_targets:
            target = staged_targets[0]
            extra  = {p["name"]: p["value"] for p in target["parameters"]}
            hdrs   = {"Content-Type": mime_type, "Content-Length": str(file_size), **extra}

            with open(file_path, "rb") as f:
                resp = requests.put(target["url"], data=f, headers=hdrs, timeout=120)

            if resp.status_code in (200, 201):
                return target["resourceUrl"]
            else:
                print(f"    ⚠️ S3 PUT failed HTTP {resp.status_code} ({filename})")
                return None

    print(f"    ❌ Failed staged upload for {filename}")
    return None


def update_collection_image(collection_gid: str, resource_url: str, alt_text: str = "") -> bool:
    """Update collection image using collectionUpdate mutation."""
    input_data = {
        "id": collection_gid,
        "image": {
            "src": resource_url,
            "altText": alt_text
        }
    }
    res = gql(API_URL, HEADERS, COLLECTION_UPDATE_MUTATION, {"input": input_data})
    if not res:
        return False

    update_data = res.get("data", {}).get("collectionUpdate", {})
    user_errors = update_data.get("userErrors", [])
    if user_errors:
        print(f"    ❌ collectionUpdate error: {user_errors}")
        return False

    new_img = update_data.get("collection", {}).get("image", {})
    if new_img and new_img.get("url"):
        return True
    return False


# ── Main ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Update Shopify Collection images from local folder")
    parser.add_argument(
        "--folder", "-f",
        default=DEFAULT_DIR,
        help="Folder containing category/collection image files"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Preview image -> collection matches without performing uploads"
    )
    args = parser.parse_args()

    folder = os.path.normpath(args.folder)
    if not os.path.exists(folder):
        print(f"❌ Folder not found: {folder}")
        sys.exit(1)

    # 1. Scan image files
    files = [
        f for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTS
    ]
    print(f"\n📂 Scanned {len(files)} image files from: {folder}")

    if not files:
        print("❌ No image files found.")
        sys.exit(0)

    # 2. Fetch collections
    collections = fetch_all_collections()

    # Build lookup dictionaries for matching
    by_handle = {}
    by_title  = {}
    by_clean  = {}

    for c in collections:
        h = c.get("handle", "")
        t = c.get("title", "")

        if h:
            by_handle[h.lower()] = c
            by_clean[normalize_name(h)] = c
        if t:
            by_title[t.lower()] = c
            by_clean[normalize_name(t)] = c

    # 3. Match image files to collections
    matches = []
    unmatched = []

    print("\n🔍 Matching images to Shopify Collections...")
    for filename in sorted(files):
        stem = os.path.splitext(filename)[0]
        stem_lower = stem.lower()
        stem_clean = normalize_name(stem)

        matched_col = None
        match_type  = ""

        # Strategy 0: Explicit Alias Map
        target_handle = ALIAS_MAP.get(stem_lower)
        if target_handle and target_handle in by_handle:
            matched_col = by_handle[target_handle]
            match_type  = f"Alias Match ({target_handle})"
        # Strategy 1: Exact handle match
        elif stem_lower in by_handle:
            matched_col = by_handle[stem_lower]
            match_type  = "Handle Match"
        # Strategy 2: Exact title match
        elif stem_lower in by_title:
            matched_col = by_title[stem_lower]
            match_type  = "Title Match"
        # Strategy 3: Cleaned alphanumeric match
        elif stem_clean in by_clean:
            matched_col = by_clean[stem_clean]
            match_type  = "Normalized Match"

        if matched_col:
            file_path = os.path.join(folder, filename)
            matches.append({
                "filename":   filename,
                "file_path":  file_path,
                "collection": matched_col,
                "match_type": match_type
            })
            print(f"  ✅ {filename:<32} →  [{matched_col['title']}] (Handle: {matched_col['handle']}) ({match_type})")
        else:
            unmatched.append(filename)
            print(f"  ⚠️ {filename:<32} →  NO MATCH FOUND")

    print(f"\n📊 Summary: {len(matches)} Matched | {len(unmatched)} Unmatched")

    if args.dry_run:
        print("\n[DRY RUN] Completed. No changes made to Shopify.")
        sys.exit(0)

    if not matches:
        print("❌ No matched collections to update.")
        sys.exit(0)

    # 4. Upload & Update Images
    print(f"\n🚀 Updating {len(matches)} Collection Images in Shopify...")
    success_count = 0
    fail_count    = 0

    for i, item in enumerate(matches, 1):
        filename  = item["filename"]
        file_path = item["file_path"]
        col       = item["collection"]
        col_gid   = col["id"]
        col_title = col["title"]

        print(f"\n[{i}/{len(matches)}] Updating '{col_title}' with '{filename}'...")

        # Step A: Staged upload
        resource_url = staged_upload_collection_image(file_path)
        if not resource_url:
            print(f"  ❌ Staged upload failed for {filename}")
            fail_count += 1
            continue

        # Step B: Update Collection Image
        ok = update_collection_image(col_gid, resource_url, alt_text=col_title)
        if ok:
            print(f"  ✅ Successfully updated collection image for '{col_title}'")
            success_count += 1
        else:
            print(f"  ❌ Failed to update collection image for '{col_title}'")
            fail_count += 1

        time.sleep(0.5)

    print(f"\n🎉 Finished! Successfully updated: {success_count} | Failed: {fail_count}")


if __name__ == "__main__":
    main()
