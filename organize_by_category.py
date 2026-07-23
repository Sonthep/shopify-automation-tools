import os
import shutil
from pathlib import Path
from pypdf import PdfReader
from collections import Counter

def categorize_pdfs():
    folder = Path('Found_PDFs')
    target_folder = folder / 'Categorized'
    
    # สร้างโฟลเดอร์ปลายทาง
    target_folder.mkdir(exist_ok=True)
    
    categories = [
        'Spec Sheet', 
        'User Manual', 
        'Warranty - Certificate', 
        'Spare Parts', 
        'Catalog',
        'Unknown'
    ]
    
    for cat in categories:
        (target_folder / cat).mkdir(exist_ok=True)
        
    pdf_files = []
    for f in folder.rglob('*.pdf'):
        if 'Corrupted_PDFs' in f.parts or 'Duplicates' in f.parts or 'Categorized' in f.parts:
            continue
        pdf_files.append(f)
        
    print(f"กำลังเริ่มย้ายไฟล์ {len(pdf_files)} ไฟล์ เข้าโฟลเดอร์ตามหมวดหมู่...")
    
    categories_count = Counter()
    
    for idx, pdf_file in enumerate(pdf_files):
        filename_lower = pdf_file.name.lower()
        category = None
        
        # 1. เช็คจากชื่อไฟล์ก่อน
        if any(w in filename_lower for w in ['spec', 'data', 'dimension']):
            category = 'Spec Sheet'
        elif any(w in filename_lower for w in ['manual', 'user', 'guide', 'instruction', 'operation', 'owner']):
            category = 'User Manual'
        elif any(w in filename_lower for w in ['part', 'diagram', 'explode', 'component']):
            category = 'Spare Parts'
        elif any(w in filename_lower for w in ['catalog', 'brochure', 'leaflet']):
            category = 'Catalog'
        elif any(w in filename_lower for w in ['warranty', 'cert', 'iso', 'ce', 'ใบรับประกัน']):
            category = 'Warranty - Certificate'
            
        # 2. เช็คจากเนื้อหา
        if not category:
            try:
                reader = PdfReader(pdf_file)
                if len(reader.pages) > 0:
                    text = reader.pages[0].extract_text()[:500].lower()
                    if any(w in text for w in ['specification', 'spec sheet', 'dimensions', 'technical data']):
                        category = 'Spec Sheet'
                    elif any(w in text for w in ['user manual', 'instruction manual', 'operating manual', 'operation manual', 'owner manual', 'instructions']):
                        category = 'User Manual'
                    elif any(w in text for w in ['spare parts', 'parts list', 'exploded view', 'wiring diagram']):
                        category = 'Spare Parts'
                    elif any(w in text for w in ['catalog', 'catalogue', 'brochure']):
                        category = 'Catalog'
                    elif any(w in text for w in ['warranty', 'certificate', 'declaration of conformity']):
                        category = 'Warranty - Certificate'
            except Exception as e:
                pass
                
        if not category:
            category = 'Unknown'
            
        categories_count[category] += 1
        
        # ย้ายไฟล์
        dest = target_folder / category / pdf_file.name
        
        # ป้องกันชื่อไฟล์ซ้ำในหมวดหมู่เดียวกัน
        if dest.exists():
            dest = target_folder / category / f"{pdf_file.stem}_{idx}.pdf"
            
        try:
            shutil.move(str(pdf_file), str(dest))
        except Exception as e:
            print(f"Error moving {pdf_file.name}: {e}")
        
        if (idx + 1) % 100 == 0:
            print(f"ย้ายไปแล้ว {idx + 1}/{len(pdf_files)} ไฟล์...")

    print("-" * 40)
    print("ย้ายไฟล์จัดหมวดหมู่เสร็จสมบูรณ์!")
    for cat, count in categories_count.most_common():
        print(f"- {cat}: {count} ไฟล์")

if __name__ == '__main__':
    categorize_pdfs()
