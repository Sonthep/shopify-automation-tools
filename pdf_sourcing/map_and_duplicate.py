import os
import shutil
import pandas as pd
from pathlib import Path
import re

def map_and_duplicate():
    # 1. การตั้งค่า
    csv_file = Path(r"bulk_product\data\find_pdf.csv")
    pdf_source = Path("Found_PDFs/Categorized")
    output_dir = Path("Web_Ready_PDFs")
    
    # 2. อ่านไฟล์ SKU
    print("กำลังอ่านไฟล์ SKU...")
    df = pd.read_csv(csv_file, encoding='utf-8-sig', on_bad_lines='skip')
    
    # หา column SKU
    if 'Variant SKU' in df.columns:
        sku_col = 'Variant SKU'
    else:
        sku_col = df.columns[0]
        
    skus = df[sku_col].dropna().astype(str).tolist()
    
    # 3. เตรียมไฟล์ PDF ทั้งหมดที่มี
    print("กำลังรวบรวมไฟล์ PDF ที่จัดหมวดหมู่แล้ว...")
    available_pdfs = list(pdf_source.rglob("*.pdf"))
    
    # สร้างโฟลเดอร์หลัก
    output_dir.mkdir(exist_ok=True)
    
    total_copied = 0
    matched_skus_count = 0
    
    print(f"พบ SKU ทั้งหมด {len(skus)} รายการ, เริ่มทำการจับคู่และคัดลอกไฟล์...")
    
    for idx, sku in enumerate(skus):
        sku = sku.strip()
        if not sku or sku.lower() == 'nan':
            continue
            
        # สร้าง Prefix จาก SKU (ตัดที่ - ตัวแรก)
        if '-' in sku:
            prefix = sku.split('-')[0] + '-'
        else:
            prefix = sku
            
        prefix_lower = prefix.lower()
        
        # หาไฟล์ PDF ที่ตรงกับ Prefix นี้
        matching_pdfs = [p for p in available_pdfs if prefix_lower in p.name.lower()]
        
        if matching_pdfs:
            matched_skus_count += 1
            # สร้างโฟลเดอร์สำหรับ SKU นี้
            # ตัดอักขระพิเศษที่ห้ามใช้เป็นชื่อโฟลเดอร์/ไฟล์ใน Windows ออก
            safe_sku = re.sub(r'[\\/*?:"<>|]', '_', sku)
            sku_folder = output_dir / safe_sku
            
            for pdf_path in matching_pdfs:
                # หาหมวดหมู่ของไฟล์นี้ (ชื่อโฟลเดอร์ที่เก็บไฟล์นี้อยู่)
                category = pdf_path.parent.name
                
                # สร้างโฟลเดอร์หมวดหมู่ย่อย
                cat_folder = sku_folder / category
                cat_folder.mkdir(parents=True, exist_ok=True)
                
                # ถ้าหมวดหมู่เป็น Unknown ให้ใช้คำว่า Datasheet แทน
                display_cat = category
                if display_cat == "Unknown":
                    display_cat = "Datasheet"
                
                # เปลี่ยนเว้นวรรคเป็น _ ในชื่อหมวดหมู่
                safe_display_cat = display_cat.replace(" ", "_").replace("-", "")
                
                # ตั้งชื่อไฟล์ใหม่เป็น [SKU]_[Category].pdf
                new_filename = f"{safe_sku}_{safe_display_cat}.pdf"
                dest_path = cat_folder / new_filename
                
                # ป้องกันกรณีมีหลายไฟล์ในหมวดหมู่เดียวกันของ SKU นี้
                counter = 1
                while dest_path.exists():
                    new_filename = f"{safe_sku}_{safe_display_cat}_{counter}.pdf"
                    dest_path = cat_folder / new_filename
                    counter += 1
                    
                # คัดลอกไฟล์
                try:
                    shutil.copy2(str(pdf_path), str(dest_path))
                    total_copied += 1
                except Exception as e:
                    print(f"Error copying to {dest_path}: {e}")
        
        if (idx + 1) % 1000 == 0:
            print(f"ประมวลผล SKU ไปแล้ว {idx + 1}/{len(skus)}...")

    print("-" * 50)
    print(f"ประมวลผลเสร็จสิ้น!")
    print(f"- นำไฟล์ไปจับคู่สำเร็จ: {matched_skus_count} SKUs")
    print(f"- จำนวนไฟล์ PDF ที่ถูกก๊อปปี้และเปลี่ยนชื่อ: {total_copied} ไฟล์")
    print(f"- ไฟล์ทั้งหมดพร้อมใช้งานอยู่ที่โฟลเดอร์: {output_dir.absolute()}")

if __name__ == '__main__':
    map_and_duplicate()
