# pdf_sourcing

สคริปต์สำหรับค้นหา คัดกรอง จัดหมวดหมู่ และจับคู่ไฟล์ PDF (spec sheet, manual, spare parts,
catalog, warranty) เข้ากับ SKU สินค้า — เป็นขั้นตอน "เตรียมไฟล์" ก่อนเอาไปอัปโหลดขึ้น Shopify
ด้วยสคริปต์ใน [`bulk_product/pdf/`](../bulk_product/pdf/)

ทำงานกับไฟล์ในเครื่อง (network drive / local folder) ล้วน ๆ — **ไม่เรียก Shopify API**

## Workflow

รันตามลำดับจาก root ของ repo (`py pdf_sourcing/<script>.py`):

1. **`find_pdf_sku.py`** — ค้นหาไฟล์ PDF ในไดรฟ์เครือข่าย (ตั้งค่าใน `SEARCH_DRIVES`) ที่ชื่อไฟล์ตรงกับ
   SKU prefix จาก `bulk_product/data/find_pdf.csv` แล้วคัดลอกมาไว้ที่ `Found_PDFs/`
2. **`remove_duplicates.py`** — เทียบ MD5 hash ของไฟล์ใน `Found_PDFs/` ย้ายไฟล์เนื้อหาซ้ำไป
   `Found_PDFs/Duplicates/`
3. **`check_corrupted_pdf.py`** — เปิดทุกไฟล์ด้วย `pypdf` ไฟล์ที่เปิดไม่ได้/ขนาด 0 ย้ายไป
   `Found_PDFs/Corrupted_PDFs/`
4. **`classify_pdfs.py`** *(ทางเลือก)* — วิเคราะห์และพิมพ์สรุปจำนวนไฟล์แต่ละหมวด โดยไม่ย้ายไฟล์จริง
   ใช้เช็คผลก่อนรัน `organize_by_category.py`
5. **`organize_by_category.py`** — จัดหมวดจริง ย้ายไฟล์เข้า `Found_PDFs/Categorized/<หมวด>/`
   (Spec Sheet, User Manual, Spare Parts, Catalog, Warranty - Certificate, Unknown)
6. **`group_by_sku.py`** *(ทางเลือก)* — จัดกลุ่มไฟล์ใน `Found_PDFs/` เป็นโฟลเดอร์ย่อยตาม SKU
   (ใช้แทน/คู่กับ ขั้นตอน 5 ได้ แล้วแต่ว่าต้องการจัดตามหมวดหรือตาม SKU)
7. **`map_and_duplicate_v2.py`** — จับคู่ไฟล์ใน `Found_PDFs/Categorized/` กับ SKU จาก
   `bulk_product/data/find_pdf.csv` (exact + substring match) แล้ว copy ไปจัดโครงสร้างใหม่เป็น
   `Web_Ready_PDFs/<SKU>/<หมวด>/<SKU>_<หมวด>.pdf` — ใช้ตัวนี้เป็นหลัก
   (`map_and_duplicate.py` คือเวอร์ชันแรกที่ match แบบ prefix ล้วน ๆ เก็บไว้เทียบผลลัพธ์เท่านั้น)

ผลลัพธ์สุดท้ายใน `Web_Ready_PDFs/` พร้อมนำไปอัปโหลดต่อด้วย
[`bulk_product/pdf/upload_pdf_from_downloads.py`](../bulk_product/pdf/upload_pdf_from_downloads.py)
หรือ [`upload_pdf_fast.py`](../bulk_product/pdf/upload_pdf_fast.py)

## Output folders (ไม่ commit เข้า git)

- `Found_PDFs/` — ไฟล์ดิบที่ค้นเจอ + โฟลเดอร์ย่อย `Duplicates/`, `Corrupted_PDFs/`, `Categorized/`
- `Web_Ready_PDFs/` — ผลลัพธ์สุดท้าย จัดตาม SKU พร้อมอัปโหลด
