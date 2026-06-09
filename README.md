# shopify-automation-tools

ชุด scripts สำหรับจัดการ Shopify store ผ่าน Admin API — อัปเดต product, สร้าง collection และจัดการ menu

---

## 📁 Project Structure

```
shoptify/
├── .env                          # API tokens (ไม่ commit)
├── .env.example                  # Template สำหรับ setup ใหม่
├── package.json
│
├── bulk-update-product/          # Python module
│   ├── utils.py                  # Shared utilities (gql, headers, CSV)
│   ├── requirements.txt
│   ├── data/                     # Input CSV files (ไม่ commit)
│   ├── output/                   # Output/result files (ไม่ commit)
│   ├── cache/                    # SKU→GID cache (ไม่ commit)
│   └── dev/                      # Debug & test scripts (ไม่ใช้ใน production)
│
├── create-collection/            # JavaScript module
│   └── create-collections.js
│
├── menu-importer/                # JavaScript module (Shopify CLI)
│   ├── import-menu.js
│   ├── fetch-menu.js
│   └── backup-menu.js
│
└── scripts/                      # Root-level utility scripts
    ├── get-menus.mjs
    ├── menus-to-csv.mjs
    └── update_inventory_auto.js
```

---

## 📦 Modules

### [`bulk-update-product/`](./bulk-update-product/)
Python scripts สำหรับอัปเดต/สร้าง/ลบ Shopify products ผ่าน Bulk Mutation GraphQL API

- อัปเดต title, description, vendor, product type, tags, price, metafields
- สร้าง product ใหม่จาก CSV
- ลบ product ตาม SKU
- อัปเดต image และ PDF file

**Stack:** Python, `requests`, `pandas`, `python-dotenv`

---

### [`create-collection/`](./create-collection/)
JavaScript script สำหรับสร้าง Shopify Smart Collections จาก CSV รายชื่อ vendor พร้อม logo image

- สร้าง Smart Collection พร้อม rule `VENDOR = <Brand Name>`
- รองรับ image URL หรือ local image

**Stack:** Node.js, `node-fetch`, `csv-parser`

---

### [`menu-importer/`](./menu-importer/)
JavaScript script สำหรับ import/export/backup เมนู Shopify storefront navigation

**Stack:** Node.js, Shopify CLI

---

### [`scripts/`](./scripts/)
Utility scripts ระดับ root สำหรับดึงเมนู, แปลง CSV, และอัปเดต inventory

---

## ⚙️ Setup

### 1. Environment Variables

คัดลอก `.env.example` แล้วกรอก token:

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

### 2. Python (bulk-update-product)

```bash
pip install -r bulk-update-product/requirements.txt
```

### 3. Node.js (create-collection, menu-importer, scripts)

```bash
npm install
```

---

## 🚀 Common Commands

```bash
# ดึงเมนูจาก Shopify
npm run get-menus

# แปลงเมนู JSON → CSV
npm run menus-to-csv

# Import เมนูเข้า Shopify
npm run import-menu

# Backup เมนูปัจจุบัน
npm run backup-menu

# สร้าง collections จาก CSV
npm run create-collections

# Python: อัปเดต product
python bulk-update-product/update_product.py

# Python: อัปเดต metafields
python bulk-update-product/update_metafields_value.py
```

---

## 🔐 Security

- ไฟล์ `.env` อยู่ใน `.gitignore` แล้ว
- ถ้าเคย commit `.env` ไปแล้ว ให้ **rotate token ทั้งหมด** ใน Shopify Admin → Apps → API credentials
- ดู [`SECURITY.md`](./menu-importer/SECURITY.md) สำหรับข้อมูลเพิ่มเติม
