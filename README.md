# shopify-automation-tools

ชุด scripts สำหรับจัดการ Shopify store ผ่าน Admin API — อัปเดต product, สร้าง collection และจัดการ menu

---

## Modules

### [`bulk-update-product/`](./bulk-update-product/)
Python scripts สำหรับอัปเดต/สร้าง/ลบ Shopify products ผ่าน Bulk Mutation GraphQL API

- อัปเดต title, description, vendor, product type, tags, price, metafields
- สร้าง product ใหม่จาก CSV
- ลบ product ตาม SKU
- อัปเดต image

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

## Setup

### Python (bulk-update-product)
```bash
pip install -r requirements.txt
```

### Node.js (create-collection, menu-importer)
```bash
npm install
```

---

## Environment Variables

สร้างไฟล์ `.env` ใน folder ที่ต้องการใช้:

```env
SHOP_NAME=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxx
```

> **หมายเหตุ:** อย่า commit ไฟล์ `.env` ลง repository
