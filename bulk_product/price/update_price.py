"""
Bulk-update Price and Compare At Price via Shopify Bulk Operation API.

CSV column names ที่รองรับ (auto-detect)
  Product GID  : "Product GID", "ProductGID", "product_gid"  ← จำเป็น
  Variant GID  : "Variant GID", "VariantGID", "variant_gid"  ← ถ้าไม่มี script จะ resolve อัตโนมัติ
  Price        : "Price", "price"
  Compare At   : "Compare At Price", "CompareAtPrice", "compare_at_price"

Mutation ที่ใช้: productVariantsBulkUpdate  (รองรับ Bulk API)
JSONL format : {"productId": "...", "variants": [{"id": "...", "price": "...", "compareAtPrice": "..."}]}

Usage
-----
    # มีแค่ Product GID + Price → script resolve Variant GID อัตโนมัติ
    py update_price.py --csv data/update_dc_rob1.csv

    # มีทั้ง Product GID + Variant GID → ข้าม resolve step
    py update_price.py --csv data/full.csv

    # Preview JSONL ก่อน upload
    py update_price.py --csv data/update_dc_rob1.csv --dry-run
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))


import argparse
import json
import os
import sys
import time

import requests

from utils import make_headers, gql, read_csv_auto, get_val, API_URL

# ── Auth ──────────────────────────────────────────────────────
HEADERS  = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
BASE_DIR = os.path.dirname(__file__)

# ── Flexible column name matching ─────────────────────────────
PRODUCT_GID_COLS = ["Product GID", "ProductGID", "product_gid", "Product Id", "ProductId"]
VARIANT_GID_COLS = ["Variant GID", "VariantGID", "variant_gid", "Variant Id", "VariantId"]
PRICE_COLS       = ["Price", "price", "ราคา"]
COMPARE_COLS     = ["Compare At Price", "CompareAtPrice", "compare_at_price", "Compare-at price", "Compare-at Price", "ราคาเปรียบเทียบ"]


def find_col(df_cols: list[str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in df_cols:
            return c
    return None


# ── Step 1a: Auto-resolve Variant GID from Product GID ───────

def resolve_variant_gids_from_products(
    product_gids: list[str],
    batch_size: int = 50,
) -> dict[str, str]:
    """
    Query Shopify to get the first Variant GID for each Product GID.
    Returns {product_gid: variant_gid or None}
    """
    result: dict[str, str] = {}
    total = len(product_gids)
    print(f"  Resolving Variant GIDs for {total} products (batch={batch_size})...")

    for i in range(0, total, batch_size):
        batch = product_gids[i : i + batch_size]
        aliases = "\n".join([
            f'p{j}: product(id: "{gid}") {{ variants(first: 1) {{ edges {{ node {{ id }} }} }} }}'
            for j, gid in enumerate(batch)
        ])
        body = gql(API_URL, HEADERS, f"{{ {aliases} }}")
        data = (body or {}).get("data", {})
        for j, gid in enumerate(batch):
            edges = (data.get(f"p{j}") or {}).get("variants", {}).get("edges", [])
            result[gid] = edges[0]["node"]["id"] if edges else None
        print(f"    Resolved {min(i + batch_size, total)}/{total}")
        time.sleep(0.3)

    missing = [g for g, v in result.items() if v is None]
    if missing:
        print(f"  ⚠️  {len(missing)} product(s) ไม่พบ variant: {missing[:5]}")
    return result


# ── Step 1b: Build JSONL ──────────────────────────────────────

def build_price_jsonl(csv_file: str, jsonl_file: str) -> int:
    """
    Build JSONL for productVariantsBulkUpdate.
    Line format: {"productId": "...", "variants": [{"id": "...", "price": "...", "compareAtPrice": "..."}]}

    ถ้าไม่มี Variant GID column จะ resolve อัตโนมัติจาก Product GID
    """
    df = read_csv_auto(csv_file)
    print(f"  Columns found: {df.columns.tolist()}")

    product_col = find_col(df.columns.tolist(), PRODUCT_GID_COLS)
    variant_col = find_col(df.columns.tolist(), VARIANT_GID_COLS)
    price_col   = find_col(df.columns.tolist(), PRICE_COLS)
    compare_col = find_col(df.columns.tolist(), COMPARE_COLS)

    # Product GID และ Price/Compare อย่างน้อยหนึ่งอย่าง เป็น required
    missing = []
    if not product_col:
        missing.append(f"Product GID  (ลองใช้ชื่อ column: {PRODUCT_GID_COLS})")
    if not price_col and not compare_col:
        missing.append("Price หรือ Compare At Price")
    if missing:
        print("[ERR] ไม่พบ column ที่จำเป็น:")
        for m in missing:
            print(f"      • {m}")
        print(f"\n      Columns ที่มีใน CSV: {df.columns.tolist()}")
        sys.exit(1)

    print(f"  ✅ Product GID → '{product_col}'")
    print(f"  ✅ Price        → '{price_col or '(ไม่มี)'}'")
    print(f"  ✅ Compare At  → '{compare_col or '(ไม่มี)'}'")

    # ── Auto-resolve Variant GID ถ้าไม่มี column ──
    variant_map: dict[str, str] = {}
    if not variant_col:
        print(f"  ℹ️  ไม่พบ Variant GID column → resolve อัตโนมัติจาก Product GID")
        valid_product_gids = (
            df[product_col]
            .dropna()
            .astype(str)
            .str.strip()
            .pipe(lambda s: s[s.str.startswith("gid://shopify/Product/")])
            .unique()
            .tolist()
        )
        variant_map = resolve_variant_gids_from_products(valid_product_gids)
    else:
        print(f"  ✅ Variant GID → '{variant_col}'")

    os.makedirs(os.path.dirname(jsonl_file), exist_ok=True)
    count   = 0
    skipped = 0

    with open(jsonl_file, "w", encoding="utf-8") as f:
        for _, row in df.iterrows():
            product_gid = get_val(row, product_col)
            if not product_gid or not product_gid.startswith("gid://shopify/Product/"):
                skipped += 1
                continue

            # ดึง Variant GID จาก column หรือจาก map ที่ resolve มา
            if variant_col:
                variant_gid = get_val(row, variant_col)
            else:
                variant_gid = variant_map.get(product_gid)

            if not variant_gid or not variant_gid.startswith("gid://shopify/ProductVariant/"):
                skipped += 1
                continue

            variant_input: dict = {"id": variant_gid}

            price = get_val(row, price_col) if price_col else None
            if price is not None:
                try:
                    variant_input["price"] = f"{float(price):.2f}"
                except ValueError:
                    print(f"  [WARN] price ไม่ใช่ตัวเลข: {price!r} — row skipped")
                    skipped += 1
                    continue

            compare = get_val(row, compare_col) if compare_col else None
            if compare is not None:
                try:
                    variant_input["compareAtPrice"] = f"{float(compare):.2f}"
                except ValueError:
                    print(f"  [WARN] compareAtPrice ไม่ใช่ตัวเลข: {compare!r} — ข้าม field นี้")

            if len(variant_input) <= 1:  # มีแค่ id ไม่มีราคา
                skipped += 1
                continue

            line = {"productId": product_gid, "variants": [variant_input]}
            f.write(json.dumps(line) + "\n")
            count += 1

    print(f"  {count} rows written → {jsonl_file}  |  {skipped} rows skipped")
    return count


# ── Step 2: Staged upload ─────────────────────────────────────

def create_staged_upload(filename: str = "price_bulk.jsonl") -> dict | None:
    query = f"""
    mutation {{
      stagedUploadsCreate(input: {{
        resource: BULK_MUTATION_VARIABLES,
        filename: "{filename}",
        mimeType: "text/jsonl",
        httpMethod: PUT
      }}) {{
        stagedTargets {{ url resourceUrl parameters {{ name value }} }}
        userErrors {{ field message }}
      }}
    }}"""
    body = gql(API_URL, HEADERS, query)
    if not body:
        return None
    data = body["data"]["stagedUploadsCreate"]
    if data.get("userErrors"):
        print(f"[ERR] stagedUploadsCreate: {data['userErrors']}")
        return None
    target = data["stagedTargets"][0]
    print(f"  Staged upload created: {target['resourceUrl']}")
    return target


def upload_jsonl(target: dict, filepath: str) -> str:
    with open(filepath, "rb") as f:
        res = requests.put(target["url"], data=f, headers={"Content-Type": "text/jsonl"})
    res.raise_for_status()
    print(f"  Uploaded {filepath}  (HTTP {res.status_code})")
    return target["resourceUrl"]


# ── Step 3: Run bulk mutation ─────────────────────────────────
# ✅ productVariantsBulkUpdate รองรับ Bulk Operation API

BULK_MUTATION = """
mutation BulkPriceUpdate($stagedUploadPath: String!) {
  bulkOperationRunMutation(
    mutation: "mutation variantPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }",
    stagedUploadPath: $stagedUploadPath
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}"""


def run_bulk_mutation(resource_url: str) -> dict | None:
    body = gql(API_URL, HEADERS, BULK_MUTATION, {"stagedUploadPath": resource_url})
    if not body:
        return None
    op = body["data"]["bulkOperationRunMutation"]
    if op["userErrors"]:
        print(f"[ERR] Bulk mutation: {op['userErrors']}")
        return None
    print(f"  Bulk operation started: {op['bulkOperation']['id']}")
    return op


# ── Step 4: Poll ──────────────────────────────────────────────

POLL_QUERY = "{ currentBulkOperation(type: MUTATION) { id status errorCode objectCount url } }"


def poll_status(interval: int = 15) -> str | None:
    while True:
        body = gql(API_URL, HEADERS, POLL_QUERY)
        op   = (body or {}).get("data", {}).get("currentBulkOperation")
        if op is None:
            print("[ERR] No active bulk operation found.")
            return None
        print(f"  [{op['status']}] {op['objectCount']} rows processed")
        if op["status"] == "COMPLETED":
            return op["url"]
        if op["status"] in ("FAILED", "CANCELED"):
            print(f"[ERR] Bulk operation failed: {op['errorCode']}")
            return None
        time.sleep(interval)


# ── Step 5: Verify result ─────────────────────────────────────

def download_and_summarise(result_url: str) -> None:
    if not result_url:
        return
    print(f"\nDownloading result from:\n  {result_url}")
    resp = requests.get(result_url, timeout=120)
    resp.raise_for_status()
    lines = [json.loads(l) for l in resp.text.splitlines() if l.strip()]
    print(f"  {len(lines)} result line(s)")
    errors = [l for l in lines if l.get("userErrors")]
    if errors:
        print(f"  ⚠️  {len(errors)} line(s) มี userErrors:")
        for e in errors[:10]:
            print(f"      {e}")
    else:
        print(f"  ✅ ไม่พบ userErrors — อัปเดต Price/Compare At Price สำเร็จทุก variant")


# ── Main ──────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Bulk-update Price & Compare At Price ด้วย productVariantsBulkUpdate"
    )
    parser.add_argument("--csv",      required=True, metavar="FILE",
                        help="CSV ที่มี: Product GID, Variant GID, Price, Compare At Price")
    parser.add_argument("--out",      default=os.path.join(BASE_DIR, "output", "price_bulk.jsonl"),
                        metavar="FILE", help="Path สำหรับ JSONL output")
    parser.add_argument("--dry-run",  action="store_true", help="Build JSONL เท่านั้น ไม่ยิง API")
    parser.add_argument("--no-verify",action="store_true", help="ข้าม verify result")
    args = parser.parse_args()

    csv_path  = args.csv if os.path.isabs(args.csv) else os.path.join(BASE_DIR, args.csv)
    jsonl_out = args.out if os.path.isabs(args.out)  else os.path.join(BASE_DIR, args.out)

    # ── 1. Build JSONL ──
    print(f"\n── Building price JSONL from: {csv_path} ──")
    count = build_price_jsonl(csv_path, jsonl_out)

    if args.dry_run:
        print(f"\n[DRY-RUN] JSONL → {jsonl_out}  (ไม่ได้ยิง API)")
        sys.exit(0)

    if count == 0:
        print("[INFO] ไม่มี row ที่ valid — จบการทำงาน")
        sys.exit(0)

    # ── 2. Staged upload ──
    print("\n── Creating staged upload ──")
    target = create_staged_upload(os.path.basename(jsonl_out))
    if not target:
        sys.exit(1)

    # ── 3. Upload JSONL ──
    print("\n── Uploading JSONL ──")
    resource_url = upload_jsonl(target, jsonl_out)

    # ── 4. Run bulk mutation ──
    print("\n── Running bulk mutation (productVariantsBulkUpdate) ──")
    op = run_bulk_mutation(resource_url)
    if not op:
        sys.exit(1)

    # ── 5. Poll ──
    print("\n── Polling bulk operation ──")
    result_url = poll_status()

    # ── 6. Verify ──
    if result_url and not args.no_verify:
        download_and_summarise(result_url)

    print(f"\n{'='*50}")
    if result_url:
        print(f"✅ เสร็จแล้ว! อัปเดต Price/Compare At Price สำเร็จ {count} variant(s)")
        print(f"   Result URL: {result_url}")
    else:
        print("❌ Bulk operation ไม่สำเร็จ")
        sys.exit(1)


if __name__ == "__main__":
    main()
