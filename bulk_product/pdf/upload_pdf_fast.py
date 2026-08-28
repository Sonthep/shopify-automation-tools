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

def register_files_batch_with_paths(staged_list: list[dict], retries: int = 3) -> dict[str, str]:
    """เหมือน register_files_batch แต่คืน {file_path: cdn_url} — ต้องรู้ว่า url
    ไหนเป็นของไฟล์ input ตัวไหน เพื่อเอาไปผูก metafield ให้ถูกสินค้า

    fileCreate คืนผลลัพธ์ตามลำดับ input เสมอ (เหมือนที่ stagedUploadsCreate ทำ
    ในฟังก์ชัน get_staged_urls_batch ด้านบน) — ถ้าจำนวนไม่ตรงกันถือว่า batch
    นี้ล้มเหลวทั้งก้อน ดีกว่าเดา URL ผิดแล้วไปอัปเดต metafield สินค้าผิดตัว

    Shopify มักคืน url: null ทันทีที่สร้าง (ยังประมวลผลไฟล์ไม่เสร็จ) ต้อง poll
    ต่อจนกว่าจะพร้อม — เหมือนที่ update_pdf_by_sku.py ทำกับไฟล์เดี่ยว แต่ที่นี่
    poll หลายไฟล์พร้อมกันต่อ batch
    """
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
            return {}

        files = body["data"]["fileCreate"]["files"]
        if not files:
            time.sleep(2 ** attempt)
            continue

        if len(files) != len(staged_list):
            print(f"[ERROR] fileCreate returned {len(files)} files for {len(staged_list)} inputs — "
                  f"order can't be trusted, skipping this batch to avoid mislinking")
            return {}

        result = {}
        pending = []  # [(file_path, file_id)]
        for s, f in zip(staged_list, files):
            if f.get("url"):
                result[s["file_path"]] = f["url"]
            elif f.get("id"):
                pending.append((s["file_path"], f["id"]))

        if pending:
            print(f"  [WAIT] {len(pending)} file(s) still processing on Shopify's side, polling...")
            for _ in range(15):  # ~30s max
                time.sleep(2)
                still_pending = []
                for file_path, file_id in pending:
                    q = f'{{ node(id: "{file_id}") {{ ... on GenericFile {{ url }} }} }}'
                    r = gql(API_URL, HEADERS, q)
                    url = (r or {}).get("data", {}).get("node", {}).get("url")
                    if url:
                        result[file_path] = url
                    else:
                        still_pending.append((file_path, file_id))
                pending = still_pending
                if not pending:
                    break
            if pending:
                print(f"  [WARN] {len(pending)} file(s) never got a URL after polling: "
                      f"{[os.path.basename(p) for p, _ in pending]}")

        return result

    print(f"[ERROR] fileCreate batch failed after {retries} retries")
    return {}

# ── Chunk helper ──────────────────────────────────────────────────────────────

def chunked(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]

# ── Track-folder mode: upload + link to a product metafield by SKU ────────────
# โฟลเดอร์ย่อยชื่อ "datasheet"/"usermanual" ใต้ --folder แต่ละไฟล์ตั้งชื่อเป็น
# {SKU}.pdf — จะถูกอัปโหลดแล้วผูกเข้ากับ metafield custom.<key> ของ SKU นั้น

TRACK_METAFIELD_MAP = {
    "datasheet":  "datasheet",
    "usermanual": "user_manual",
}

METAFIELDS_SET_MUTATION = """
mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { key value }
    userErrors { field message code elementIndex }
  }
}
"""


def get_gids_by_skus(skus: list[str], batch_size: int = 50) -> dict:
    """Resolve SKU -> Product GID ผ่าน aliased query แบบ batch (ไม่ยิงทีละ SKU)"""
    gid_map = {}
    total = len(skus)
    for i in range(0, total, batch_size):
        batch = skus[i:i + batch_size]
        aliases = " ".join(
            f'p{j}: productVariants(first: 1, query: "sku:{sku}") '
            f'{{ edges {{ node {{ product {{ id }} }} }} }}'
            for j, sku in enumerate(batch)
        )
        body = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, sku in enumerate(batch):
            edges = data.get(f"p{j}", {}).get("edges", [])
            gid_map[sku] = edges[0]["node"]["product"]["id"] if edges else None
        print(f"  [SKU] Resolved {min(i + batch_size, total)}/{total}")
        time.sleep(0.5)
    return gid_map


def set_metafields_batch(entries: list[dict], retries: int = 3) -> list[dict]:
    """entries: [{ownerId, key, value}] — namespace เป็น 'custom' และ type เป็น 'url' เสมอ"""
    variables = {
        "metafields": [
            {"ownerId": e["ownerId"], "namespace": "custom", "key": e["key"], "value": e["value"], "type": "url"}
            for e in entries
        ]
    }
    for attempt in range(1, retries + 1):
        body = gql(API_URL, HEADERS, METAFIELDS_SET_MUTATION, variables)
        if not body:
            time.sleep(2 ** attempt)
            continue

        data = body.get("data", {}).get("metafieldsSet", {})
        errors = data.get("userErrors", [])
        if errors:
            print(f"[ERROR] metafieldsSet batch: {errors}")
        return data.get("metafields", [])

    print(f"[ERROR] metafieldsSet batch failed after {retries} retries")
    return []


def upload_by_track_folders(parent_folder: str, workers: int = 10, batch_size: int = 25):
    """parent_folder ต้องมีโฟลเดอร์ย่อยตาม TRACK_METAFIELD_MAP (datasheet/, usermanual/)
    ไฟล์ในแต่ละโฟลเดอร์ตั้งชื่อเป็น {SKU}.pdf"""

    # 1. รวบรวมงานจากทุก track folder ที่เจอ
    jobs = []  # [{file_path, sku, track, metafield_key}]
    for track, metafield_key in TRACK_METAFIELD_MAP.items():
        track_folder = os.path.join(parent_folder, track)
        if not os.path.isdir(track_folder):
            print(f"[INFO] Track folder not found, skipping: {track_folder}")
            continue
        pdfs = sorted(f for f in os.listdir(track_folder)
                      if f.lower().endswith(".pdf") and os.path.isfile(os.path.join(track_folder, f)))
        print(f"[INFO] Track '{track}' -> custom.{metafield_key}: {len(pdfs)} file(s)")
        for f in pdfs:
            jobs.append({
                "file_path":     os.path.join(track_folder, f),
                "sku":           os.path.splitext(f)[0],
                "track":         track,
                "metafield_key": metafield_key,
            })

    if not jobs:
        print(f"[ERROR] No PDFs found under any track folder in: {parent_folder}")
        print(f"        Expected subfolders: {', '.join(TRACK_METAFIELD_MAP)}")
        return

    total = len(jobs)
    print(f"\n[INFO] {total} file(s) total | workers={workers} | batch={batch_size}")
    t_start = time.time()

    # 2. Resolve SKU -> Product GID (unique SKUs only, batched)
    unique_skus = sorted({j["sku"] for j in jobs})
    print(f"\n[PHASE 0] Resolving {len(unique_skus)} unique SKU(s)...")
    gid_map = get_gids_by_skus(unique_skus)

    matched_jobs = [j for j in jobs if gid_map.get(j["sku"])]
    unmatched_jobs = [j for j in jobs if not gid_map.get(j["sku"])]
    for j in unmatched_jobs:
        print(f"  ⚠️ SKU not found on Shopify, skipping: {j['sku']} ({j['track']}/{os.path.basename(j['file_path'])})")

    if not matched_jobs:
        print("[ERROR] No SKUs matched a product. Nothing to upload.")
        return

    job_by_path = {j["file_path"]: j for j in matched_jobs}
    file_paths = [j["file_path"] for j in matched_jobs]

    # 3. Phase 1: Batch stagedUploadsCreate
    print(f"\n[PHASE 1] Getting staged upload URLs for {len(matched_jobs)} file(s)...")
    all_staged = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(get_staged_urls_batch, chunk) for chunk in chunked(file_paths, batch_size)]
        for future in as_completed(futures):
            all_staged.extend(future.result() or [])
    print(f"[PHASE 1] Got {len(all_staged)}/{len(matched_jobs)} staged URLs")

    # 4. Phase 2: Parallel S3 PUT
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

    # 5. Phase 3: Batch fileCreate — เก็บ url ผูกกลับ file_path เพื่อรู้ว่าเป็นของสินค้า/track ไหน
    print("\n[PHASE 3] Registering files in Shopify (batch)...")
    file_url_by_path = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(register_files_batch_with_paths, chunk) for chunk in chunked(s3_success, batch_size)]
        for future in as_completed(futures):
            file_url_by_path.update(future.result())
    print(f"[PHASE 3] Registered {len(file_url_by_path)}/{len(s3_success)} file(s)")

    # 6. Phase 4: Batch metafieldsSet — ผูก url เข้ากับ custom.<track> ของสินค้านั้น
    print("\n[PHASE 4] Linking files to product metafields...")
    metafield_entries = [
        {
            "ownerId": gid_map[job_by_path[path]["sku"]],
            "key":     job_by_path[path]["metafield_key"],
            "value":   url,
        }
        for path, url in file_url_by_path.items()
    ]

    linked = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(set_metafields_batch, chunk) for chunk in chunked(metafield_entries, batch_size)]
        for future in as_completed(futures):
            result = future.result()
            linked += len(result)
            for m in result:
                print(f"  [OK] custom.{m['key']} = {m['value']}")

    elapsed = time.time() - t_start
    print(f"\n{'='*50}")
    print(f"[DONE] Linked: {linked} | SKU not found: {len(unmatched_jobs)} | Total input: {total}")
    print(f"[TIME] {elapsed:.1f}s")
    print(f"{'='*50}")

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
    parser.add_argument("--folder",  default="pdfs", help="PDF folder (flat mode) or parent folder containing track subfolders (--track mode)")
    parser.add_argument("--workers", default=10, type=int, help="Parallel workers (max 10)")
    parser.add_argument("--batch",   default=25, type=int, help="Files per mutation (max 25)")
    parser.add_argument("--track", action="store_true",
                         help="Treat --folder as a parent folder with subfolders named after "
                              f"TRACK_METAFIELD_MAP ({', '.join(TRACK_METAFIELD_MAP)}); each PDF is "
                              "named {SKU}.pdf and gets linked to that product's matching custom.<key> metafield")
    args = parser.parse_args()

    workers    = min(max(args.workers, 1), 10)
    batch_size = min(max(args.batch,   1), 25)

    if not os.path.isdir(args.folder):
        print(f"[ERROR] Folder not found: {args.folder}")
        sys.exit(1)

    if args.track:
        upload_by_track_folders(args.folder, workers, batch_size)
    else:
        upload_all_fast(args.folder, workers, batch_size)

if __name__ == "__main__":
    main()
