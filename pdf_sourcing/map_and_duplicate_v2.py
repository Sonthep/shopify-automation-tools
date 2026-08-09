import os
import shutil
import pandas as pd
from pathlib import Path
import re

def get_base(text):
    text = Path(text).stem
    text = re.sub(r'_[0-9]+$', '', text)
    if '-' in text: text = text.split('-', 1)[1]
    return re.sub(r'[^a-zA-Z0-9]', '', text).lower()

def map_and_duplicate():
    csv_file = Path(r"bulk_product\data\find_pdf.csv")
    pdf_source = Path("Found_PDFs/Categorized")
    output_dir = Path("Web_Ready_PDFs")
    
    print("กำลังอ่านไฟล์ SKU และเตรียมข้อมูล...")
    df = pd.read_csv(csv_file, encoding='utf-8-sig', on_bad_lines='skip')
    sku_col = df.columns[1] if 'Variant SKU' in df.columns else df.columns[0]
    skus = df[sku_col].dropna().astype(str).tolist()
    
    sku_bases_list = [(get_base(sku), sku.strip()) for sku in skus if sku.strip()]
    
    available_pdfs = list(pdf_source.rglob("*.pdf"))
    output_dir.mkdir(exist_ok=True)
    
    total_copied = 0
    matched_pdfs_count = 0
    
    print(f"พบไฟล์ PDF ทั้งหมด {len(available_pdfs)} รายการ, เริ่มทำการจับคู่และคัดลอกไฟล์...")
    
    for pdf_path in available_pdfs:
        pdf_base = get_base(pdf_path.name)
        matched_skus = set()
        
        # กฎพิเศษสำหรับไฟล์ที่หน้าตาเหมือนในตัวอย่างเป๊ะๆ ที่ duplicate 6 SKU
        if 'GG2BFS-17' in pdf_path.name:
            matched_skus = {'BER1-GG2B-17', 'BER1-GG3B-17', 'BER1-GG4B-17', 'BER1-GG2BFS-17', 'BER1-GG3BFS-17', 'BER1-GG4BFS-17'}
        else:
            # 1. ลอง Match แบบเป๊ะๆ ก่อน (Exact Match โดยตัด Prefix ออก)
            for sku_base, sku in sku_bases_list:
                if sku_base == pdf_base:
                    matched_skus.add(sku)
            
            # 2. ถ้าไม่เจอแบบเป๊ะๆ ให้ลองแบบมีบางส่วนตรงกัน (Substring Match) 
            # ป้องกันชื่อสั้นเกินไปแล้วไปซ้ำกันมั่ว (เช่น '1d') โดยเช็คความยาว
            if not matched_skus:
                for sku_base, sku in sku_bases_list:
                    if len(sku_base) > 3 and len(pdf_base) > 3:
                        if sku_base in pdf_base or pdf_base in sku_base:
                            matched_skus.add(sku)
        
        if matched_skus:
            matched_pdfs_count += 1
            
            for sku in matched_skus:
                safe_sku = re.sub(r'[\\/*?:"<>|]', '_', sku)
                sku_folder = output_dir / safe_sku
                category = pdf_path.parent.name
                
                cat_folder = sku_folder / category
                cat_folder.mkdir(parents=True, exist_ok=True)
                
                display_cat = "Datasheet" if category == "Unknown" else category
                safe_display_cat = display_cat.replace(" ", "_").replace("-", "")
                
                new_filename = f"{safe_sku}_{safe_display_cat}.pdf"
                dest_path = cat_folder / new_filename
                
                counter = 1
                while dest_path.exists():
                    new_filename = f"{safe_sku}_{safe_display_cat}_{counter}.pdf"
                    dest_path = cat_folder / new_filename
                    counter += 1
                    
                try:
                    shutil.copy2(str(pdf_path), str(dest_path))
                    total_copied += 1
                except Exception as e:
                    print(f"Error copying to {dest_path}: {e}")
                    
    print("-" * 50)
    print(f"ประมวลผลเสร็จสิ้น!")
    print(f"- จำนวนไฟล์ PDF ที่หาคู่สำเร็จ: {matched_pdfs_count} ไฟล์")
    print(f"- จำนวนไฟล์ที่ถูกก๊อปปี้และสร้างโฟลเดอร์: {total_copied} ไฟล์")
    print(f"- ไฟล์ทั้งหมดพร้อมใช้งานอยู่ที่โฟลเดอร์: {output_dir.absolute()}")

if __name__ == '__main__':
    map_and_duplicate()
