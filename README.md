# shopify-automation-tools

ชุด scripts สำหรับจัดการ Shopify store ผ่าน Admin API — อัปเดต product, จัดการรูป/PDF,
sync กับ Google Sheets, และจัดการเมนู/บล็อก/collection

---

## 📁 Project Structure

```
shopify-automation-tools/
├── .env                      # API tokens (ไม่ commit)
├── .env.example              # Template สำหรับ setup ใหม่
├── shopify_client.py         # Shared Shopify API client (gql, throttle retry, token refresh)
├── gen_token.py              # ขอ Admin API token ใหม่ (Client Credentials)
├── package.json
│
├── bulk_product/             # Python — Shopify Admin GraphQL Bulk Mutation API (โมดูลหลัก)
│   ├── products/ collections/ metafields/ images/ pdf/ price/ reports/
│   ├── utils.py               # Shared helpers (gql, SKU→GID cache, CSV I/O)
│   ├── data/ output/ cache/    # Input/output/cache ต่อ run (ไม่ commit)
│   └── dev/                    # Debug & one-off scripts (ไม่ใช้ใน production)
│
├── pdf_sourcing/              # Python — ค้นหา/จัดหมวด/จับคู่ PDF เข้ากับ SKU ก่อนอัปโหลด
│                               # (ดูลำดับขั้นตอนใน pdf_sourcing/README.md)
│
├── appscript/                 # Google Apps Script — sync ข้อมูล product/inventory/price กับ Sheets
│
├── menu/                      # Python — CRUD เมนู storefront ผ่าน Admin API
├── bulk_blog/                 # Python — สร้าง/แก้ไขบทความบล็อกแบบ bulk
├── download/                  # Python — ดาวน์โหลด/rename รูปภาพเป็นชุด (batch)
├── scraper/                   # Python — scrape ข้อมูลจากเว็บ/YouTube ภายนอก
├── scripts/                   # Node (.mjs) — ดึงเมนู, แปลงเมนูเป็น CSV / Python — export product ไป Sheet
├── scratch/                   # สคริปต์ทดลอง/debug ข้ามโมดูล (ไม่ใช้ใน production)
├── requirements.txt           # Python deps ของทั้ง repo
└── .github/workflows/ci.yml   # Syntax check (Python + Node/Apps Script) และ secret scan
```

---

## 📦 Modules

### [`bulk_product/`](./bulk_product/)
โมดูลหลัก — จัดการ Shopify products, collections, metafields, images, PDF, price ผ่าน
Bulk Mutation GraphQL API ดูรายละเอียดสคริปต์ทั้งหมดใน [`bulk_product/README.md`](./bulk_product/README.md)

**Stack:** Python, `requests`, `pandas`, `python-dotenv`

### [`pdf_sourcing/`](./pdf_sourcing/)
ค้นหาไฟล์ PDF (spec sheet, manual, spare parts ฯลฯ) จากไดรฟ์เครือข่าย จัดหมวดหมู่ และจับคู่เข้ากับ SKU
ก่อนส่งต่อให้ `bulk_product/pdf/` อัปโหลดขึ้น Shopify — ทำงานกับไฟล์ในเครื่องล้วน ๆ ไม่เรียก Shopify API
ดูลำดับขั้นตอนแบบละเอียดใน [`pdf_sourcing/README.md`](./pdf_sourcing/README.md)

### [`appscript/`](./appscript/)
Google Apps Script (deploy แยกใน Google Sheets/Apps Script editor เอง ไม่ได้รันจาก repo นี้ — ต้อง
copy โค้ดเข้า Apps Script editor เอง) สำหรับ export/sync product, inventory และ price ระหว่าง
Shopify กับ Google Sheets รวมถึง trigger-based script ที่เคย commit ผิดที่มาไว้ใน `scripts/`
(`update_price.js`, `update_inventory_auto.js` — ใช้ `PropertiesService`/`Logger` ของ Apps Script
รันผ่าน `node` ไม่ได้)

### [`menu/`](./menu/), [`bulk_blog/`](./bulk_blog/)
Python scripts จัดการเมนู storefront และบทความบล็อกผ่าน Admin API แบบ bulk

### [`download/`](./download/), [`scraper/`](./scraper/)
Utility scripts สำหรับดาวน์โหลด/จัดชุดรูปภาพ และ scrape ข้อมูลจากเว็บภายนอก (ใช้ประกอบการเตรียมข้อมูลสินค้า)

### [`scripts/`](./scripts/)
Utility scripts ระดับ root — ดึงเมนู (`get-menus.mjs`), แปลงเมนูเป็น CSV (`menus-to-csv.mjs`),
export product ไป Google Sheet (`export_products_to_sheet.py`)

---

## ⚙️ Setup

### 1. Environment Variables

```bash
cp .env.example .env
```

```env
SHOP_NAME=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxx
SHOPIFY_ACCESS_TOKEN_CATEGORY=shpat_xxxxxxxxxx
SHOPIFY_ACCESS_TOKEN_IMPORT_MENU=shpat_xxxxxxxxxx
SHOPIFY_ACCESS_TOKEN_IMPORT_PRODUCT=shpat_xxxxxxxxxx
SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT=shpat_xxxxxxxxxx
SHOPIFY_LOCATION_ID=gid://shopify/Location/xxxxxxxxxx
PUBLIC_STOREFRONT_API_TOKEN=xxxxxxxxxx
```

> ⚠️ **อย่า commit ไฟล์ `.env`** — มี token จริงอยู่

### 2. Python

```bash
pip install -r requirements.txt
```

### 3. Node.js (scripts/)

```bash
npm install
```

---

## 🚀 Common Commands

```bash
# ดึงเมนูจาก Shopify → JSON
npm run get-menus

# แปลงเมนู JSON → CSV
npm run menus-to-csv

# ขอ Admin API token ใหม่
npm run gen-token

# Python: อัปเดต product / metafields
python bulk_product/products/update_product.py
python bulk_product/metafields/update_metafields_value.py
```

---

## 🛡️ Dry-run mode & mutation audit log

ทุกสคริปต์ Python ที่เรียก Shopify ผ่าน `shopify_client.py` (โดยตรงหรือผ่าน `bulk_product/utils.py`)
รองรับ **dry-run** แบบรวมศูนย์ — ไม่ต้องแก้สคริปต์แต่ละตัว:

```bash
# ตั้งใน .env หรือ export ก่อนรัน
DRY_RUN=true python bulk_product/products/update_product.py
```

เมื่อ `DRY_RUN=true`: ทุก GraphQL **mutation** จะไม่ถูกส่งไป Shopify จริง (query แบบอ่านอย่างเดียว
เช่น resolve SKU→GID ยังทำงานปกติ) สคริปต์จะได้ผลลัพธ์เป็น `None` เหมือนตอน call ล้มเหลว — เหมาะ
สำหรับเช็คว่าสคริปต์รันได้ไม่ error ก่อนยิงจริง แต่ตัวเลข success/fail ที่สคริปต์พิมพ์ออกมาใน
dry-run **จะไม่ตรงกับความเป็นจริง** (เพราะไม่ได้รับ response กลับมา) — ให้ดูไฟล์ JSONL ที่สคริปต์
สร้างไว้ก่อนอัปโหลด (เช่น `bulk_product/products/output/bulk.jsonl`) เป็นตัว preview ที่แม่นยำกว่า

ทุก mutation (ทั้ง dry-run และของจริง) จะถูกบันทึกไว้ที่ `logs/mutations.log`
(timestamp, สคริปต์ที่เรียก, token env, query, variables) — ใช้ตรวจสอบย้อนหลังว่าตอนไหนมีการแก้
อะไรไปบ้าง โฟลเดอร์ `logs/` ไม่ commit เข้า git

> **ข้อจำกัด:** นี่คือ audit log ว่า "ส่งอะไรไปเมื่อไหร่" ไม่ใช่ snapshot ของ "ค่าก่อนแก้" — ถ้าต้อง
> rollback ได้แบบอัตโนมัติสำหรับสคริปต์ที่ risk สูง (เช่น update ราคาทั้งร้าน) ควร query ค่าปัจจุบัน
> ไปเก็บเป็นไฟล์ก่อนรัน mutation เพิ่มเติมเฉพาะสคริปต์นั้น ๆ เอาเอง

Node.js (`scripts/*.mjs`) และ Google Apps Script (`appscript/`) ไม่ได้อยู่ใน dry-run นี้ — ยังไม่มี
mutation ฝั่ง Node ที่ยิง Shopify โดยตรงตอนนี้ (`get-menus.mjs`/`menus-to-csv.mjs` เป็น read-only/
local file เท่านั้น) ส่วน Apps Script ต้อง deploy เข้า Google เองจึงไม่มี hook รวมศูนย์แบบเดียวกัน

---

## ✅ CI

`.github/workflows/ci.yml` รันอัตโนมัติทุก push/PR เข้า `main`:
- Python syntax check (`python -m compileall`)
- Node/Apps Script syntax check (`node --check` — parse เฉยๆ ไม่รัน จึงเช็ค `appscript/*.js` ที่ใช้
  Apps Script global ได้โดยไม่ error)
- Secret scan (กัน `.env` หลุดเข้า git และกัน Shopify token จริงถูก commit)

---

## 🔐 Security

- ไฟล์ `.env` อยู่ใน `.gitignore` แล้ว
- ถ้าเคย commit `.env` ไปแล้ว ให้ **rotate token ทั้งหมด** ใน Shopify Admin → Settings → Apps →
  Develop apps
