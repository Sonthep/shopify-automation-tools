import os
import shutil
import pandas as pd
from pathlib import Path

# ==========================================
# การตั้งค่า (Configuration)
# ==========================================
INPUT_FILE = r"bulk_product\data\find_pdf.csv"       # ไฟล์ตั้งต้นที่ใส่รายการ SKU
OUTPUT_FILE = r"bulk_product\data\find_pdf_result.csv"     # ไฟล์ผลลัพธ์ที่จะได้
DESTINATION_FOLDER = "Found_PDFs"   # โฟลเดอร์สำหรับเก็บไฟล์ PDF ที่หาเจอ

SEARCH_DRIVES = [
    "X:\\",
    r"T:\#ต่างประเทศ"
]
# ==========================================

def main():
    # 1. สร้างโฟลเดอร์ปลายทางถ้ายังไม่มี
    os.makedirs(DESTINATION_FOLDER, exist_ok=True)

    # 2. อ่านไฟล์ SKU
    try:
        if INPUT_FILE.endswith('.csv'):
            try:
                df = pd.read_csv(INPUT_FILE, encoding='utf-8-sig')
            except UnicodeDecodeError:
                df = pd.read_csv(INPUT_FILE, encoding='cp874')
        else:
            df = pd.read_excel(INPUT_FILE)
    except FileNotFoundError:
        print(f"[Warning] ไม่พบไฟล์ {INPUT_FILE}")
        print(f"กำลังสร้างไฟล์ตัวอย่าง {INPUT_FILE} ให้...")
        # สร้างไฟล์ตัวอย่างให้ใช้งาน
        df_sample = pd.DataFrame({
            "SKU": ["LKK1-BM-4TA", "TEST-123"],
            "Remark": ["", ""]
        })
        df_sample.to_excel(INPUT_FILE, index=False)
        print(f"[OK] สร้างไฟล์ {INPUT_FILE} สำเร็จ! \n-> กรุณาเปิดไฟล์ {INPUT_FILE} แล้วนำ SKU ของคุณไปใส่ในคอลัมน์แรก จากนั้นรันสคริปต์นี้อีกครั้งครับ")
        return

    # หาระบุชื่อคอลัมน์ Variant SKU ถ้ามี
    if 'Variant SKU' in df.columns:
        sku_col = 'Variant SKU'
    else:
        sku_col = df.columns[0]
        
    if 'Remark' not in df.columns:
        df['Remark'] = ""

    prefixes_to_search = set()
    prefix_mapping = {}

    for index, row in df.iterrows():
        sku = str(row[sku_col]).strip()
        if not sku or sku.lower() == 'nan':
            continue
        
        # ตัด prefix ออก เช่น LKK1-BM-4TA เอา LKK1-
        if '-' in sku:
            prefix = sku.split('-')[0] + '-'
        else:
            prefix = sku
        
        prefixes_to_search.add(prefix.lower())
        if prefix.lower() not in prefix_mapping:
            prefix_mapping[prefix.lower()] = []
        prefix_mapping[prefix.lower()].append(index)

    print(f"[Info] โหลดรายการมาทั้งหมด {len(df)} SKUs -> ได้ Prefix ที่จะใช้ค้นหา {len(prefixes_to_search)} แบบ")

    # 3. ค้นหาไฟล์ PDF
    found_prefixes = set()

    for drive in SEARCH_DRIVES:
        if not os.path.exists(drive):
            print(f"[Warning] ไม่สามารถเข้าถึงไดรฟ์/โฟลเดอร์: {drive} (ข้ามการค้นหา)")
            continue
        
        print(f"กำลังค้นหาใน {drive} ... (อาจใช้เวลาสักครู่)")
        for root, dirs, files in os.walk(drive):
            for file in files:
                if file.lower().endswith('.pdf'):
                    file_lower = file.lower()
                    # เช็คว่ามี prefix ตัวไหนตรงกับชื่อไฟล์ไหม
                    for prefix in prefixes_to_search:
                        if prefix in file_lower:
                            source_path = os.path.join(root, file)
                            dest_path = os.path.join(DESTINATION_FOLDER, file)
                            
                            # ถ้ายังไม่มีไฟล์นี้ในโฟลเดอร์ปลายทาง ค่อย copy
                            if not os.path.exists(dest_path):
                                try:
                                    shutil.copy2(source_path, dest_path)
                                    print(f"[OK] คัดลอกสำเร็จ: {file} (เจอจาก {prefix})")
                                except Exception as e:
                                    print(f"[Error] Error copying {source_path}: {e}")
                            
                            found_prefixes.add(prefix)

    # 4. อัปเดต Remark ว่า "check แล้ว" สำหรับตัวที่หาไฟล์เจอ
    for prefix in found_prefixes:
        indices = prefix_mapping.get(prefix, [])
        for idx in indices:
            df.at[idx, 'Remark'] = "check แล้ว"

    # 5. บันทึกผลลัพธ์
    if OUTPUT_FILE.endswith('.csv'):
        df.to_csv(OUTPUT_FILE, index=False, encoding='utf-8-sig')
    else:
        df.to_excel(OUTPUT_FILE, index=False)

    print(f"\n[Done] ดำเนินการเสร็จสิ้น! ดูผลลัพธ์ได้ที่ไฟล์ {OUTPUT_FILE} และไฟล์ PDF อยู่ในโฟลเดอร์ {DESTINATION_FOLDER}")

if __name__ == "__main__":
    main()
