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
├── scripts/                   # Node/Python — get menu, export product ไป Sheet, update price/inventory
└── scratch/                   # สคริปต์ทดลอง/debug ข้ามโมดูล (ไม่ใช้ใน production)
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
Google Apps Script (deploy แยกใน Google Sheets/Apps Script editor เอง ไม่ได้รันจาก repo นี้)
สำหรับ export/sync product, inventory และ price ระหว่าง Shopify กับ Google Sheets

### [`menu/`](./menu/), [`bulk_blog/`](./bulk_blog/)
Python scripts จัดการเมนู storefront และบทความบล็อกผ่าน Admin API แบบ bulk

### [`download/`](./download/), [`scraper/`](./scraper/)
Utility scripts สำหรับดาวน์โหลด/จัดชุดรูปภาพ และ scrape ข้อมูลจากเว็บภายนอก (ใช้ประกอบการเตรียมข้อมูลสินค้า)

### [`scripts/`](./scripts/)
Utility scripts ระดับ root — ดึงเมนู, แปลงเมนูเป็น CSV, export product ไป Google Sheet, อัปเดต price/inventory

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
pip install -r bulk_product/requirements.txt
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

# อัปเดต inventory / price (Node)
npm run update-inventory
npm run update-price

# ขอ Admin API token ใหม่
npm run gen-token

# Python: อัปเดต product / metafields (รันจากใน bulk_product/)
python bulk_product/products/update_product.py
python bulk_product/metafields/update_metafields_value.py
```

---

## 🔐 Security

- ไฟล์ `.env` อยู่ใน `.gitignore` แล้ว
- ถ้าเคย commit `.env` ไปแล้ว ให้ **rotate token ทั้งหมด** ใน Shopify Admin → Settings → Apps →
  Develop apps
