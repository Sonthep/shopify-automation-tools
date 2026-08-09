import os
import shutil
import re
from pathlib import Path

def group_pdfs_by_sku():
    source_folder = Path("Found_PDFs")
    
    if not source_folder.exists():
        print(f"Folder {source_folder} does not exist.")
        return

    print("กำลังจัดกลุ่มไฟล์ PDF ลงในโฟลเดอร์ตาม SKU...")
    
    # ดึงเฉพาะไฟล์ .pdf ที่อยู่ในโฟลเดอร์หลัก (ไม่รวมไฟล์ในโฟลเดอร์ย่อย)
    pdf_files = [f for f in source_folder.glob("*.pdf") if f.is_file()]
    
    moved_count = 0
    sku_folders = set()

    for pdf_file in pdf_files:
        name_without_ext = pdf_file.stem
        
        # ตัด _1, _2, _3 ที่อยู่ท้ายชื่อออก เพื่อหาชื่อ SKU หลัก
        # ใช้ regex ลบ _ ตามด้วยตัวเลขที่อยู่ท้ายสุด
        base_sku = re.sub(r'_[0-9]+$', '', name_without_ext).strip()
        
        # ถ้าไม่มี base_sku ให้ใช้ชื่อไฟล์เดิม
        if not base_sku:
            base_sku = name_without_ext
            
        # สร้างโฟลเดอร์ชื่อ SKU ถ้ายังไม่มี
        sku_folder = source_folder / base_sku
        sku_folder.mkdir(exist_ok=True)
        sku_folders.add(base_sku)
        
        # ย้ายไฟล์
        dest_file = sku_folder / pdf_file.name
        
        try:
            # ถ้ามีไฟล์อยู่แล้วให้ข้าม หรืออาจจะลบทิ้ง แต่ปกติน่าจะไม่มี
            if not dest_file.exists():
                shutil.move(str(pdf_file), str(dest_file))
                moved_count += 1
        except Exception as e:
            print(f"[Error] ไม่สามารถย้ายไฟล์ {pdf_file.name}: {e}")

    print("-" * 40)
    print(f"สร้างโฟลเดอร์ SKU ทั้งหมด: {len(sku_folders)} โฟลเดอร์")
    print(f"ย้ายไฟล์สำเร็จ: {moved_count} ไฟล์")
    print(f"จัดหมวดหมู่เสร็จสิ้น! เข้าไปดูในโฟลเดอร์ Found_PDFs ได้เลยครับ")

if __name__ == '__main__':
    group_pdfs_by_sku()
