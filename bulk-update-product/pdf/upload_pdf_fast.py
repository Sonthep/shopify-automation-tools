"""
Upload PDF files to Shopify Files — Fastest method
Pipeline: Parallel staged upload → Parallel S3 PUT → Batch fileCreate (25/mutation)

Usage:
    py upload_pdf_fast.py
    py upload_pdf_fast.py --folder pdfs/ --workers 10 --batch 25
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))


import os
import sys
import time
import argparse
import mimetypes
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from utils import make_headers, gql, API_URL

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# ── GraphQL ──────────────────────────────────────────────────────────────────

STAGED_UPLOAD_MUTATION = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
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
mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      ... on GenericFile {
        id
        url
        createdAt
      }
    }
    userErrors { field message }
  }
}
"""

# ── Step 1: Batch stagedUploadsCreate (ส่งได้หลายไฟล์ต่อครั้ง) ──────────────

def get_staged_urls_batch(file_paths: list[str]) -> list[dict] | None:
    """stagedUploadsCreate หลายไฟล์พร้อมกันใน 1 mutation"""
    inputs = []
    for fp in file_paths:
        filename  = os.path.basename(fp)
        file_size = os.path.getsize(fp)
        mime_type = mimetypes.guess_type(fp)[0] or "application/pdf"
        inputs.append({
            "filename":   filename,
            "mimeType":   mime_type,
            "fileSize":   str(file_size),
            "httpMethod": "PUT",
            "resource":   "FILE",
        })

    body = gql(API_URL, HEADERS, STAGED_UPLOAD_MUTATION, {"input": inputs})
    if not body:
        return None

    errors = body.get("data", {}).get("stagedUploadsCreate", {}).get("userErrors", [])
    if errors:
        print(f"[ERROR] stagedUploadsCreate batch: {errors}")
        return None

    targets = body["data"]["stagedUploadsCreate"]["stagedTargets"]
    if len(targets) != len(file_paths):
        print(f"[ERROR] Mismatch: {len(file_paths)} files but {len(targets)} targets")
        return None

    results = []
    for fp, target in zip(file_paths, targets):
        mime_type = mimetypes.guess_type(fp)[0] or "application/pdf"
        results.append({
            "file_path":    fp,
            "filename":     os.path.basename(fp),
            "mime_type":    mime_type,
            "upload_url":   target["url"],
            "resource_url": target["resourceUrl"],
            "parameters":   target["parameters"],
        })
    return results

# ── Step 2: PUT → S3 (parallel) ───────────────────────────────────────────────

def put_to_s3(staged: dict, retries: int = 3) -> bool:
    """Upload ตรงไป S3 — เร็วที่สุด ไม่ผ่าน Shopify"""
    for attempt in range(1, retries + 1):
        try:
            file_size = os.path.getsize(staged["file_path"])
            # Parameters must be headers, NOT query params (query params break S3 pre-signed URL)
            extra_headers = {p["name"]: p["value"] for p in staged["parameters"]}
            headers = {"Content-Type": staged["mime_type"], "Content-Length": str(file_size), **extra_headers}
            with open(staged["file_path"], "rb") as f:
                resp = requests.put(
                    staged["upload_url"],
                    data=f,
                    headers=headers,
                    timeout=120,
                )
            if resp.status_code in (200, 201):
                return True
            print(f"[WARN] S3 {staged['filename']} attempt {attempt} → HTTP {resp.status_code}")
        except Exception as ex:
            print(f"[WARN] S3 {staged['filename']} attempt {attempt} → {ex}")
        time.sleep(2 ** attempt)

    print(f"[ERROR] S3 PUT failed: {staged['filename']}")
    return False

# ── Step 3: Batch fileCreate (25 ไฟล์ต่อ mutation) ───────────────────────────

def register_files_batch(staged_list: list[dict], retries: int = 3) -> list[dict]:
    """fileCreate หลายไฟล์พร้อมกัน — สูงสุด 25 ต่อ mutation"""
    variables = {
        "files": [
            {"originalSource": s["resource_url"], "contentType": "FILE"}
            for s in staged_list
        ]
    }

    for attempt in range(1, retries + 1):
        body = gql(API_URL, HEADERS, FILE_CREATE_MUTATION, variables)
        if not body:
            time.sleep(2 ** attempt)
            continue

        errors = body.get("data", {}).get("fileCreate", {}).get("userErrors", [])
        if errors:
            print(f"[ERROR] fileCreate batch: {errors}")
            return []

        files = body["data"]["fileCreate"]["files"]
        if files:
            return files

        time.sleep(2 ** attempt)

    print(f"[ERROR] fileCreate batch failed after {retries} retries")
    return []

# ── Chunk helper ──────────────────────────────────────────────────────────────

def chunked(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]

# ── Main pipeline ─────────────────────────────────────────────────────────────

def upload_all_fast(folder: str, workers: int = 10, batch_size: int = 25):
    # รวบรวมไฟล์ PDF
    pdf_files = sorted([
        os.path.join(folder, f)
        for f in os.listdir(folder)
        if f.lower().endswith(".pdf") and os.path.isfile(os.path.join(folder, f))
    ])

    if not pdf_files:
        print(f"[INFO] No PDF files in '{folder}'")
        return

    total = len(pdf_files)
    print(f"[INFO] {total} PDF file(s) | workers={workers} | batch={batch_size}")
    t_start = time.time()

    # ── Phase 1: Batch stagedUploadsCreate (25 ไฟล์/mutation, parallel) ──
    print("\n[PHASE 1] Getting staged upload URLs...")
    all_staged = []

    def fetch_staged_batch(chunk):
        result = get_staged_urls_batch(chunk)
        return result or []

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(fetch_staged_batch, chunk)
                   for chunk in chunked(pdf_files, batch_size)]
        for future in as_completed(futures):
            all_staged.extend(future.result())

    print(f"[PHASE 1] Got {len(all_staged)}/{total} staged URLs")

    # ── Phase 2: Parallel S3 PUT ──────────────────────────────────────────
    print("\n[PHASE 2] Uploading to S3 (parallel)...")
    s3_success = []

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(put_to_s3, s): s for s in all_staged}
        for future in as_completed(futures):
            staged = futures[future]
            if future.result():
                s3_success.append(staged)
            else:
                print(f"[SKIP] {staged['filename']} — S3 upload failed")

    print(f"[PHASE 2] S3 uploaded: {len(s3_success)}/{len(all_staged)}")

    # ── Phase 3: Batch fileCreate (25/mutation, parallel) ────────────────
    print("\n[PHASE 3] Registering files in Shopify (batch)...")
    registered = 0
    failed     = 0

    def register_batch(chunk):
        return register_files_batch(chunk)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(register_batch, chunk)
                   for chunk in chunked(s3_success, batch_size)]
        for future in as_completed(futures):
            files = future.result()
            registered += len(files)
            failed     += (batch_size - len(files)) if len(files) < batch_size else 0
            for f in files:
                print(f"[OK] {f.get('url', 'N/A')}")

    elapsed = time.time() - t_start
    print(f"\n{'='*50}")
    print(f"[DONE] Success: {registered} | Failed: {total - registered} | Total: {total}")
    print(f"[TIME] {elapsed:.1f}s  ({total/elapsed:.1f} files/sec)")
    print(f"{'='*50}")

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Upload PDFs to Shopify — Fastest")
    parser.add_argument("--folder",  default="pdfs", help="PDF folder")
    parser.add_argument("--workers", default=10, type=int, help="Parallel workers (max 10)")
    parser.add_argument("--batch",   default=25, type=int, help="Files per mutation (max 25)")
    args = parser.parse_args()

    workers    = min(max(args.workers, 1), 10)
    batch_size = min(max(args.batch,   1), 25)

    if not os.path.isdir(args.folder):
        print(f"[ERROR] Folder not found: {args.folder}")
        sys.exit(1)

    upload_all_fast(args.folder, workers, batch_size)

if __name__ == "__main__":
    main()
