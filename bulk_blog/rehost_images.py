"""
rehost_images.py
----------------
Download images from temporary/private URLs (e.g. ChatGPT backend URLs),
upload them to Shopify Files, then rewrite the CSV so every image URL points
to the new permanent Shopify CDN URL.

Columns scanned automatically:
  - "Image URL"  -> featured image column (direct URL value)
  - "Body"       -> scans <img src="..."> tags inside HTML
  - "Body_TH"    -> same for Thai body column

Usage:
  py rehost_images.py --csv data/sample_articles.csv
  py rehost_images.py --csv data/sample_articles.csv --out data/articles_fixed.csv
"""

import sys
import os
import re
import argparse
import time
import mimetypes
import importlib.util
import requests
import pandas as pd

# ── Load shared utils ────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(BASE_DIR)
UTILS_PATH = os.path.join(ROOT_DIR, "bulk_product", "utils.py")

spec = importlib.util.spec_from_file_location("utils", UTILS_PATH)
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)

make_headers  = utils.make_headers
gql           = utils.gql
API_URL       = utils.API_URL
read_csv_auto = utils.read_csv_auto

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# ── Config ────────────────────────────────────────────────────────────────────
IMAGE_COL  = "Image URL"
HTML_COLS  = ["Body", "Body_TH"]
IMG_TAG_RE = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']', re.IGNORECASE)

# ── GraphQL mutations ─────────────────────────────────────────────────────────
STAGED_UPLOAD_MUTATION = """
mutation StagedUpload($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}
"""

FILE_CREATE_MUTATION = """
mutation FileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      ... on MediaImage {
        id
        image { url }
      }
      ... on GenericFile {
        id
        url
      }
    }
    userErrors { field message }
  }
}
"""

FILE_STATUS_QUERY = """
query FileStatus($id: ID!) {
  node(id: $id) {
    ... on MediaImage {
      id
      fileStatus
      image { url }
    }
    ... on GenericFile {
      id
      fileStatus
      url
    }
  }
}
"""


# ── Core upload pipeline ──────────────────────────────────────────────────────

def download_image(url: str, dest_dir: str):
    """Download image from URL OR copy local file. Returns (local_path, filename) or None."""
    os.makedirs(dest_dir, exist_ok=True)

    # ── Local file path ───────────────────────────────────────────────────────
    if os.path.exists(url) or (not url.startswith("http") and os.sep in url):
        if not os.path.isfile(url):
            print(f"    ERROR: Local file not found: {url}")
            return None
        filename  = os.path.basename(url)
        dest_path = os.path.join(dest_dir, filename)
        import shutil
        shutil.copy2(url, dest_path)
        return dest_path, filename

    # ── HTTP URL ──────────────────────────────────────────────────────────────
    try:
        r = requests.get(url, timeout=30, headers={
            "User-Agent": "Mozilla/5.0 (compatible; ShopifyImageRehost/1.0)"
        })
        r.raise_for_status()
    except Exception as e:
        print(f"    ERROR download: {e}")
        return None

    content_type = r.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
    ext = mimetypes.guess_extension(content_type) or ".jpg"
    ext = ext.replace(".jpe", ".jpg")

    base_name = re.sub(r"[^\w]", "_", url.split("?")[0].split("/")[-1] or "image")[:60]
    if not base_name.lower().endswith(ext):
        base_name += ext

    local_path = os.path.join(dest_dir, base_name)
    with open(local_path, "wb") as f:
        f.write(r.content)
    return local_path, base_name


def staged_upload(local_path: str, filename: str, mime_type: str):
    """Stage and upload file to Shopify. Returns staged path or None."""
    res = gql(API_URL, HEADERS, STAGED_UPLOAD_MUTATION, {
        "input": [{
            "resource":   "IMAGE",
            "filename":   filename,
            "mimeType":   mime_type,
            "httpMethod": "POST",
        }]
    })
    if not res:
        print("    ERROR: stagedUploadsCreate failed")
        return None

    targets = res.get("data", {}).get("stagedUploadsCreate", {}).get("stagedTargets", [])
    if not targets:
        print("    ERROR: No staged targets returned")
        return None

    target = targets[0]
    params = {p["name"]: p["value"] for p in target["parameters"]}

    with open(local_path, "rb") as f:
        upload_res = requests.post(
            target["url"],
            data=params,
            files={"file": (filename, f, mime_type)}
        )

    if not upload_res.ok:
        print(f"    ERROR: Upload to staged storage failed: {upload_res.status_code}")
        return None

    # fileCreate mutation expects the full resourceUrl, NOT just the key
    return target["resourceUrl"]


def create_file_on_shopify(staged_path: str, alt: str = ""):
    """Run fileCreate and poll until READY. Returns public CDN URL or None."""
    res = gql(API_URL, HEADERS, FILE_CREATE_MUTATION, {
        "files": [{
            "alt":            alt or "",
            "contentType":    "IMAGE",
            "originalSource": staged_path,
        }]
    })
    if not res:
        print("    ERROR: fileCreate failed")
        return None

    errors = res.get("data", {}).get("fileCreate", {}).get("userErrors", [])
    if errors:
        print(f"    ERROR: fileCreate userErrors: {errors}")
        return None

    files = res.get("data", {}).get("fileCreate", {}).get("files", [])
    if not files:
        print("    ERROR: fileCreate returned no files")
        return None

    file_id = files[0].get("id")

    # Poll until READY
    for attempt in range(20):
        time.sleep(2)
        status_res = gql(API_URL, HEADERS, FILE_STATUS_QUERY, {"id": file_id})
        node   = (status_res or {}).get("data", {}).get("node", {})
        status = node.get("fileStatus", "")
        if status == "READY":
            cdn_url = (node.get("image") or {}).get("url") or node.get("url", "")
            return cdn_url
        if status == "FAILED":
            print(f"    ERROR: File processing FAILED")
            return None
        print(f"    Waiting... ({status}) attempt {attempt+1}/20")

    print("    ERROR: Timed out waiting for READY")
    return None


def rehost_url(url: str, cache: dict, tmp_dir: str) -> str:
    """Download + upload one URL. Uses cache to avoid duplicate uploads."""
    if url in cache:
        return cache[url]

    print(f"  Downloading: {url[:90]}")
    result = download_image(url, tmp_dir)
    if not result:
        cache[url] = url
        return url

    local_path, filename = result
    mime_type, _ = mimetypes.guess_type(local_path)
    mime_type = mime_type or "image/jpeg"

    print(f"  Uploading:   {filename}")
    staged_path = staged_upload(local_path, filename, mime_type)
    if not staged_path:
        cache[url] = url
        return url

    cdn_url = create_file_on_shopify(staged_path, alt=filename)
    if not cdn_url:
        cache[url] = url
        return url

    print(f"  OK: {cdn_url[:90]}")
    cache[url] = cdn_url

    try:
        os.remove(local_path)
    except OSError:
        pass

    return cdn_url


# ── Helpers ───────────────────────────────────────────────────────────────────

def extract_img_urls(html: str) -> list:
    return list(dict.fromkeys(IMG_TAG_RE.findall(html)))


def replace_urls_in_html(html: str, url_map: dict) -> str:
    for old, new in url_map.items():
        if old != new:
            html = html.replace(old, new)
    return html


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Rehost CSV images to Shopify Files")
    parser.add_argument("--csv", required=True, help="Input CSV path")
    parser.add_argument("--out", default=None,  help="Output CSV path (default: overwrite input)")
    args = parser.parse_args()

    input_path  = args.csv
    output_path = args.out or input_path

    if not os.path.exists(input_path):
        print(f"[ERROR] File not found: {input_path}")
        sys.exit(1)

    tmp_dir = os.path.join(BASE_DIR, "output", "_tmp_images")
    os.makedirs(tmp_dir, exist_ok=True)

    print(f"\nReading {input_path}...")
    df = read_csv_auto(input_path)

    url_cache = {}
    all_urls  = set()

    # Collect all URLs
    if IMAGE_COL in df.columns:
        for val in df[IMAGE_COL].dropna():
            u = str(val).strip()
            if u:
                all_urls.add(u)

    for col in HTML_COLS:
        if col in df.columns:
            for val in df[col].dropna():
                for u in extract_img_urls(str(val)):
                    all_urls.add(u)

    print(f"\nFound {len(all_urls)} unique image URL(s) to rehost\n")

    # Rehost each URL
    for i, url in enumerate(sorted(all_urls), 1):
        print(f"[{i}/{len(all_urls)}]")
        rehost_url(url, url_cache, tmp_dir)
        time.sleep(0.3)

    # Rewrite DataFrame
    if IMAGE_COL in df.columns:
        df[IMAGE_COL] = df[IMAGE_COL].apply(
            lambda v: url_cache.get(str(v).strip(), v) if not pd.isna(v) else v
        )

    for col in HTML_COLS:
        if col in df.columns:
            df[col] = df[col].apply(
                lambda v: replace_urls_in_html(str(v), url_cache) if not pd.isna(v) else v
            )

    df.to_csv(output_path, index=False, encoding="utf-8-sig")

    changed = sum(1 for old, new in url_cache.items() if old != new)

    try:
        os.rmdir(tmp_dir)
    except OSError:
        pass

    print(f"\n{'='*50}")
    print(f"Rehosted {changed}/{len(all_urls)} URLs successfully")
    print(f"Saved to: {output_path}")
    print(f"{'='*50}")
    print("Now re-run:  py create_articles.py --csv " + output_path)


if __name__ == "__main__":
    main()
