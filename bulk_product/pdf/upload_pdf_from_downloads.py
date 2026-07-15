"""
upload_pdf_from_downloads.py
Upload PDF files from C:\\Users\\0125024\\Downloads\\upload pdf → Shopify Files

Pipeline:
  1) Batch stagedUploadsCreate (25 files/mutation, parallel)
  2) Parallel S3 PUT
  3) Batch fileCreate (25/mutation, parallel)

Usage:
    py upload_pdf_from_downloads.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import time
import mimetypes
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from utils import make_headers, gql, API_URL

# ── Config ────────────────────────────────────────────────────────────────────

FOLDER     = r"C:\Users\0125024\Downloads\upload pdf"
WORKERS    = 10   # parallel threads
BATCH_SIZE = 25   # files per mutation (Shopify max = 25)

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

# ── GraphQL mutations ──────────────────────────────────────────────────────────

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

# ── Step 1: Batch stagedUploadsCreate ─────────────────────────────────────────

def get_staged_urls_batch(file_paths: list[str]) -> list[dict] | None:
    inputs = []
    for fp in file_paths:
        mime_type = mimetypes.guess_type(fp)[0] or "application/pdf"
        inputs.append({
            "filename":   os.path.basename(fp),
            "mimeType":   mime_type,
            "fileSize":   str(os.path.getsize(fp)),
            "httpMethod": "PUT",
            "resource":   "FILE",
        })

    body = gql(API_URL, HEADERS, STAGED_UPLOAD_MUTATION, {"input": inputs})
    if not body:
        return None

    errors = body.get("data", {}).get("stagedUploadsCreate", {}).get("userErrors", [])
    if errors:
        print(f"[ERROR] stagedUploadsCreate: {errors}")
        return None

    targets = body["data"]["stagedUploadsCreate"]["stagedTargets"]
    if len(targets) != len(file_paths):
        print(f"[ERROR] Mismatch: {len(file_paths)} files, {len(targets)} targets")
        return None

    results = []
    for fp, target in zip(file_paths, targets):
        results.append({
            "file_path":    fp,
            "filename":     os.path.basename(fp),
            "mime_type":    mimetypes.guess_type(fp)[0] or "application/pdf",
            "upload_url":   target["url"],
            "resource_url": target["resourceUrl"],
            "parameters":   target["parameters"],
        })
    return results

# ── Step 2: PUT to S3 ─────────────────────────────────────────────────────────

def put_to_s3(staged: dict, retries: int = 3) -> bool:
    for attempt in range(1, retries + 1):
        try:
            extra = {p["name"]: p["value"] for p in staged["parameters"]}
            headers = {
                "Content-Type":   staged["mime_type"],
                "Content-Length": str(os.path.getsize(staged["file_path"])),
                **extra,
            }
            with open(staged["file_path"], "rb") as f:
                resp = requests.put(staged["upload_url"], data=f, headers=headers, timeout=300)
            if resp.status_code in (200, 201):
                return True
            print(f"[WARN] {staged['filename']} attempt {attempt} → HTTP {resp.status_code}")
        except Exception as ex:
            print(f"[WARN] {staged['filename']} attempt {attempt} → {ex}")
        time.sleep(2 ** attempt)

    print(f"[ERROR] S3 PUT failed: {staged['filename']}")
    return False

# ── Step 3: Batch fileCreate ──────────────────────────────────────────────────

def register_files_batch(staged_list: list[dict], retries: int = 3) -> list[dict]:
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
            print(f"[ERROR] fileCreate: {errors}")
            return []

        files = body["data"]["fileCreate"]["files"]
        if files:
            return files

        time.sleep(2 ** attempt)

    print(f"[ERROR] fileCreate failed after {retries} retries")
    return []

# ── Chunk helper ──────────────────────────────────────────────────────────────

def chunked(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not os.path.isdir(FOLDER):
        print(f"[ERROR] Folder not found: {FOLDER}")
        sys.exit(1)

    # รวบรวมไฟล์ PDF ทั้งหมดในโฟลเดอร์
    pdf_files = sorted([
        os.path.join(FOLDER, f)
        for f in os.listdir(FOLDER)
        if f.lower().endswith(".pdf") and os.path.isfile(os.path.join(FOLDER, f))
    ])

    if not pdf_files:
        print(f"[INFO] ไม่พบไฟล์ PDF ใน: {FOLDER}")
        sys.exit(0)

    total = len(pdf_files)
    print(f"📂 Folder : {FOLDER}")
    print(f"📄 PDF files found: {total}")
    for f in pdf_files:
        size_mb = os.path.getsize(f) / 1024 / 1024
        print(f"   • {os.path.basename(f)}  ({size_mb:.2f} MB)")

    print(f"\n⚙️  workers={WORKERS} | batch={BATCH_SIZE}")
    t_start = time.time()

    # ── Phase 1: Staged Upload URLs ──
    print("\n[PHASE 1] Getting staged upload URLs...")
    all_staged: list[dict] = []

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = [ex.submit(get_staged_urls_batch, chunk)
                   for chunk in chunked(pdf_files, BATCH_SIZE)]
        for future in as_completed(futures):
            result = future.result()
            if result:
                all_staged.extend(result)

    print(f"[PHASE 1] ✅ Got {len(all_staged)}/{total} staged URLs")
    if not all_staged:
        print("[ERROR] ไม่สามารถรับ staged URLs ได้ หยุดทำงาน")
        sys.exit(1)

    # ── Phase 2: S3 PUT ──
    print("\n[PHASE 2] Uploading to S3...")
    s3_success: list[dict] = []

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(put_to_s3, s): s for s in all_staged}
        for future in as_completed(futures):
            staged = futures[future]
            if future.result():
                s3_success.append(staged)
                print(f"  ✅ {staged['filename']}")
            else:
                print(f"  ❌ {staged['filename']} — S3 failed")

    print(f"[PHASE 2] ✅ S3 uploaded: {len(s3_success)}/{len(all_staged)}")
    if not s3_success:
        print("[ERROR] ไม่มีไฟล์ที่ upload S3 สำเร็จ")
        sys.exit(1)

    # ── Phase 3: fileCreate ──
    print("\n[PHASE 3] Registering files in Shopify...")
    registered = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = [ex.submit(register_files_batch, chunk)
                   for chunk in chunked(s3_success, BATCH_SIZE)]
        for future in as_completed(futures):
            files = future.result()
            registered += len(files)
            for f in files:
                print(f"  🔗 {f.get('url', 'N/A')}")

    elapsed = time.time() - t_start
    print(f"\n{'='*55}")
    print(f"🎉 เสร็จสิ้น!")
    print(f"   ✅ สำเร็จ  : {registered} ไฟล์")
    print(f"   ❌ ล้มเหลว : {total - registered} ไฟล์")
    print(f"   ⏱️  ใช้เวลา : {elapsed:.1f}s")
    print(f"{'='*55}")

if __name__ == "__main__":
    main()
