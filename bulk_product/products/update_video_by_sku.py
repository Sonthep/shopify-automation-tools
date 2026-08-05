"""
update_video_by_sku.py
======================
Add (or replace) an EXTERNAL_VIDEO (YouTube) media to Shopify products.

Input CSV columns (required):
    sku            - product SKU
    youtube_url    - YouTube URL  e.g. https://youtu.be/VIDEO_ID
                                  or   https://www.youtube.com/watch?v=VIDEO_ID

Usage:
    python update_video_by_sku.py --csv data/update_video.csv
    python update_video_by_sku.py --csv data/update_video.csv --delete-old  # remove existing videos first
    python update_video_by_sku.py --csv data/update_video.csv --dry-run
"""

import sys
import os
import time
import argparse
import csv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils import make_headers, gql, API_URL, read_csv_auto

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
DEFAULT_CSV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "update_video.csv")

# ──────────────────────────────────────────────
# GraphQL queries / mutations
# ──────────────────────────────────────────────
QUERY_PRODUCT_BY_SKU = """
query($query: String!) {
  products(first: 1, query: $query) {
    edges {
      node {
        id
        title
        media(first: 50) {
          edges {
            node {
              id
              mediaContentType
              status
            }
          }
        }
      }
    }
  }
}
"""

QUERY_PRODUCT_BY_ID = """
query($id: ID!) {
  product(id: $id) {
    id
    title
    media(first: 50) {
      edges {
        node {
          id
          mediaContentType
          status
        }
      }
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


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
def normalize_youtube_url(url: str) -> str:
    """
    Accepts both short (youtu.be/ID) and long (youtube.com/watch?v=ID) URLs.
    Returns the short https://youtu.be/ID form which Shopify accepts.
    """
    url = url.strip()
    if "youtu.be/" in url:
        return url  # already short form
    if "youtube.com/watch" in url:
        # extract ?v=
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(url)
        vid_id = parse_qs(parsed.query).get("v", [None])[0]
        if vid_id:
            return f"https://youtu.be/{vid_id}"
    return url  # return as-is and let Shopify validate


def add_video_to_product(product_id: str, youtube_url: str, dry_run: bool = False) -> bool:
    """Call productCreateMedia with EXTERNAL_VIDEO type."""
    media_input = [{
        "mediaContentType": "EXTERNAL_VIDEO",
        "originalSource": youtube_url
    }]
    print(f"    🎬 Adding video: {youtube_url}")
    if dry_run:
        print("    [DRY-RUN] Skipping API call.")
        return True

    res = gql(API_URL, HEADERS, MUTATION_CREATE_MEDIA, {
        "productId": product_id,
        "media": media_input
    })
    if res is None:
        print("    ❌ API call failed.")
        return False

    errors = res.get("data", {}).get("productCreateMedia", {}).get("mediaUserErrors", [])
    if errors:
        print(f"    ❌ productCreateMedia errors: {errors}")
        return False

    added = res.get("data", {}).get("productCreateMedia", {}).get("media", [])
    print(f"    ✅ Media added: id={added[0]['id'] if added else 'N/A'}  status={added[0]['status'] if added else 'N/A'}")
    return True


def delete_existing_videos(product_id: str, media_edges: list, dry_run: bool = False) -> None:
    """Delete all EXTERNAL_VIDEO media on a product."""
    video_ids = [
        e["node"]["id"]
        for e in media_edges
        if e["node"]["mediaContentType"] == "EXTERNAL_VIDEO"
    ]
    if not video_ids:
        print("    ℹ️  No existing videos to delete.")
        return
    print(f"    🗑️  Deleting {len(video_ids)} existing video(s)...")
    if dry_run:
        print("    [DRY-RUN] Skipping delete.")
        return
    res = gql(API_URL, HEADERS, MUTATION_DELETE_MEDIA, {
        "productId": product_id,
        "mediaIds": video_ids
    })
    if res is None:
        print("    ❌ Delete call failed.")
        return
    deleted = res.get("data", {}).get("productDeleteMedia", {}).get("deletedMediaIds", [])
    print(f"    ✅ Deleted {len(deleted)} video media item(s).")


def process_row(sku: str, youtube_url: str, delete_old: bool, dry_run: bool, product_gid: str = "") -> bool:
    print(f"\n  SKU/ID: {sku or product_gid}")

    clean_url = normalize_youtube_url(youtube_url)
    product_id = ""

    # If we have product_gid, we might be able to skip the lookup entirely!
    if product_gid:
        if not str(product_gid).startswith("gid://shopify/Product/"):
            product_id = f"gid://shopify/Product/{product_gid}"
        else:
            product_id = str(product_gid)

        if not delete_old:
            # SUPER FAST PATH: No query needed, just mutate!
            print(f"    ⚡ FAST PATH using Product GID: {product_id}")
            return add_video_to_product(product_id, clean_url, dry_run)
            
        # If we need to delete old videos, we must query the product by ID to get media edges
        res = gql(API_URL, HEADERS, QUERY_PRODUCT_BY_ID, {"id": product_id})
        if not res or not res.get("data", {}).get("product"):
            print(f"    ❌ Product not found for GID: {product_id}")
            return False
        product = res["data"]["product"]
        print(f"    📦 Found by GID: {product.get('title')} ({product_id})")
        media_edges = product.get("media", {}).get("edges", [])

    else:
        # Fallback to SKU lookup
        res = gql(API_URL, HEADERS, QUERY_PRODUCT_BY_SKU, {"query": f"sku:{sku}"})
        if not res:
            print(f"    ❌ GraphQL error looking up SKU.")
            return False

        edges = res.get("data", {}).get("products", {}).get("edges", [])
        if not edges:
            print(f"    ❌ Product not found for SKU: {sku}")
            return False

        product = edges[0]["node"]
        product_id = product["id"]
        print(f"    📦 Found: {product.get('title')} ({product_id})")
        media_edges = product.get("media", {}).get("edges", [])

    # 2. Delete old videos (optional)
    if delete_old:
        delete_existing_videos(product_id, media_edges, dry_run)

    # 3. Add the new video
    return add_video_to_product(product_id, clean_url, dry_run)


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Add / replace YouTube video media on Shopify products by SKU."
    )
    parser.add_argument("--csv", default=DEFAULT_CSV,
                        help=f"Path to CSV file (default: {DEFAULT_CSV})")
    parser.add_argument("--delete-old", action="store_true",
                        help="Delete existing EXTERNAL_VIDEO media before adding the new one")
    parser.add_argument("--dry-run", action="store_true",
                        help="Look up products but skip all write operations")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process only the first N rows (useful for testing)")
    args = parser.parse_args()

    csv_path = args.csv
    if not os.path.exists(csv_path):
        print(f"❌ CSV file not found: {csv_path}")
        print("   Create a CSV with columns: sku, youtube_url")
        sys.exit(1)

    # Read CSV
    df = read_csv_auto(csv_path)
    df.columns = [c.strip().lower() for c in df.columns]
    # Check for flexible column names
    gid_col = "product gid" if "product gid" in df.columns else "product_gid" if "product_gid" in df.columns else None
    url_col = "link_video" if "link_video" in df.columns else "link video" if "link video" in df.columns else "youtube_url" if "youtube_url" in df.columns else None
    sku_col = "variant sku" if "variant sku" in df.columns else "sku" if "sku" in df.columns else None

    # We need EITHER sku OR product gid, plus youtube_url/link_video
    if not url_col:
        print(f"❌ Missing URL column (link_video or youtube_url) in CSV. Found: {list(df.columns)}")
        sys.exit(1)
        
    if not sku_col and not gid_col:
        print(f"❌ Missing identifier column (variant sku, sku, or product_gid) in CSV. Found: {list(df.columns)}")
        sys.exit(1)

    # Convert to records
    rows = df.to_dict("records")
    if args.limit:
        rows = rows[: args.limit]

    print(f"📋 Total rows to process: {len(rows)}")
    if args.dry_run:
        print("🔍 DRY-RUN mode — no data will be written.")
    if args.delete_old:
        print("🗑️  DELETE-OLD mode — existing videos will be removed first.")

    success, fail = 0, 0
    failed_rows = []

    for row in rows:
        url = str(row.get(url_col, "")).strip() if url_col else ""
        sku = str(row.get(sku_col, "")).strip() if sku_col else ""
        pgid = str(row.get(gid_col, "")).strip() if gid_col else ""
        
        # Handle "nan" from pandas
        if sku.lower() == "nan": sku = ""
        if pgid.lower() == "nan": pgid = ""
        if url.lower() == "nan": url = ""

        if not url or (not sku and not pgid):
            continue
            
        try:
            ok = process_row(sku, url, delete_old=args.delete_old, dry_run=args.dry_run, product_gid=pgid)
            if ok:
                success += 1
            else:
                fail += 1
                failed_rows.append({"sku": sku, "product_gid": pgid, "link_video": url})
        except Exception as e:
            print(f"    ❌ Exception: {e}")
            fail += 1
            failed_rows.append({"sku": sku, "product_gid": pgid, "link_video": url})

        time.sleep(0.5)  # avoid rate limiting

    print(f"\n{'='*50}")
    print(f"✅ Success : {success}")
    print(f"❌ Failed  : {fail}")

    # Write failed rows to CSV for retry
    if failed_rows:
        fail_path = os.path.join(os.path.dirname(csv_path), "failed_video.csv")
        with open(fail_path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=["sku", "product_gid", "link_video"])
            writer.writeheader()
            writer.writerows(failed_rows)
        print(f"⚠️  Failed rows saved to: {fail_path}")


if __name__ == "__main__":
    main()
