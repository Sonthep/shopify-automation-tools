# bulk-update-product

ชุด Python scripts สำหรับจัดการ Shopify products ผ่าน Admin GraphQL API (Bulk Mutation)

---

## Requirements

```bash
pip install -r requirements.txt
```

Dependencies: `requests`, `pandas`, `python-dotenv`

---

## Environment Variables

สร้างไฟล์ `.env` ที่ root ของ folder นี้:

```env
SHOP_NAME=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT=shpat_xxxxxxxxxx
```

---

## Scripts

### `fetch_product_gids.py` — สร้าง cache SKU → GID
รันครั้งเดียวเพื่อดึง GID ของทุก product มาเก็บใน `product_gids.json`  
Scripts อื่นจะใช้ cache นี้แทนการ query API ทุกครั้ง

```bash
py fetch_product_gids.py
```

---

### `update-product.py` — อัปเดตข้อมูล product (Bulk)
อัปเดต title, description, vendor, product type, tags, status, price และ metafields ผ่าน Bulk Mutation API

**CSV:** `test_update_data.csv`

| Column | ผล |
|---|---|
| `Variant SKU` | ใช้ resolve product GID |
| `Title` | ชื่อ product |
| `Body (HTML)` | คำอธิบาย (descriptionHtml) |
| `Vendor` | vendor |
| `Product Type` | productType + metafield `custom.part_type` |
| `Tags` | tags (คั่นด้วย `,`) |
| `Status` | ACTIVE / DRAFT / ARCHIVED |
| `Price` | ราคา variant |
| `Compare At Price` | ราคาเปรียบเทียบ |

```bash
py update-product.py
```

---

### `update_metafield.py` — อัปเดต metafields (Bulk)
อัปเดต metafields `custom.part_type` และ `custom.power_type`

**CSV:** `update_power_type.csv` (หรือแก้ `CSV_FILE` ในไฟล์)

| Column | Metafield |
|---|---|
| `part_type` | `custom.part_type` |
| `power_type` | `custom.power_type` |

```bash
py update_metafield.py
```

> หาก `product_gids.json` มีอยู่แล้ว จะใช้ cache แทนการ query API

---

### `update-image.py` — อัปเดตรูปภาพ product
ลบรูปเดิมทั้งหมดแล้วอัปโหลดรูปใหม่จาก URL

**CSV:** `update_image.csv`

| Column | คำอธิบาย |
|---|---|
| `Variant SKU` | SKU ของสินค้า |
| `Image Src` | URL รูปภาพ (คั่นด้วย `,` ถ้ามีหลายรูป) |

```bash
py update-image.py
```

---

### `create_new_product.py` — สร้าง product ใหม่
สร้าง product พร้อม variants และ metafields

**CSV:** `test_create.csv`

```bash
py create_new_product.py
```

---

### `delete.py` — ลบ products
ลบ products ตาม SKU (มี confirmation prompt ก่อนลบ)

**CSV:** `delete_1469.csv` (หรือแก้ `CSV_FILE` ในไฟล์)

| Column | คำอธิบาย |
|---|---|
| `Variant SKU` | SKU ของสินค้าที่ต้องการลบ |

```bash
py delete.py
```

---

### `export_image_vendor.py` — ดึงรูปภาพ Collection ของ Vendor (Collection Logo/Header Image)
ดึงรูปภาพของ Collection ที่เป็น Vendor (มีเงื่อนไข `Vendor is equal to ...`) ออกมาเป็น Excel/CSV หรือดาวน์โหลดไฟล์รูปภาพลงเครื่อง

```bash
# ดึงรูป Collection ของ Vendor ทั้งหมด
py images/export_image_vendor.py

# กรองเฉพาะ Vendor ที่ต้องการ (เช่น PRIMO หรือ Sirman)
py images/export_image_vendor.py --vendor "PRIMO"

# ดาวน์โหลดไฟล์รูปภาพลงโฟลเดอร์ในเครื่องด้วย (--download)
py images/export_image_vendor.py --download

# กรองเฉพาะ Collection ที่มีรูปภาพเท่านั้น
py images/export_image_vendor.py --no-empty
```

---

## Workflow ทั่วไป

```
1. รัน fetch_product_gids.py  →  สร้าง product_gids.json (ทำครั้งเดียว)
2. เตรียม CSV ตาม format ของแต่ละ script
3. รัน script ที่ต้องการ
4. ตรวจสอบ not_found.csv หากมี SKU ที่หาไม่เจอ
```

---

## Output Files

| File | คำอธิบาย |
|---|---|
| `product_gids.json` | Cache SKU → GID |
| `bulk.jsonl` | JSONL ที่ส่งไป Shopify Bulk API |
| `not_found.csv` | SKU ที่หา product GID ไม่เจอ (update-product) |
| `not_found_metafield.csv` | SKU ที่หาไม่เจอ (update_metafield) |
