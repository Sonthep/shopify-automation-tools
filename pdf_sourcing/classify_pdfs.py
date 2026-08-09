import os
from pathlib import Path
from pypdf import PdfReader
from collections import Counter

def classify_pdfs():
    folder = Path('Found_PDFs')
    
    categories_count = Counter()
    
    pdf_files = []
    for f in folder.rglob('*.pdf'):
        if 'Corrupted_PDFs' in f.parts or 'Duplicates' in f.parts:
            continue
        pdf_files.append(f)
        
    print(f"กำลังเริ่มอ่านเนื้อหาภายในไฟล์ PDF จำนวน {len(pdf_files)} ไฟล์ เพื่อจัดหมวดหมู่...")
    
    for idx, pdf_file in enumerate(pdf_files):
        # 1. ลองวิเคราะห์จากชื่อไฟล์ก่อน (ชื่อไฟล์มักบอกได้ชัดเจน)
        filename_lower = pdf_file.name.lower()
        category = None
        
        if any(w in filename_lower for w in ['spec', 'data', 'dimension']):
            category = 'Spec Sheet / Data Sheet'
        elif any(w in filename_lower for w in ['manual', 'user', 'guide', 'instruction', 'operation', 'owner']):
            category = 'User Manual / Operation Guide'
        elif any(w in filename_lower for w in ['part', 'diagram', 'explode', 'component']):
            category = 'Spare Parts / Diagram'
        elif any(w in filename_lower for w in ['catalog', 'brochure', 'leaflet']):
            category = 'Catalog / Brochure'
        elif any(w in filename_lower for w in ['warranty', 'cert', 'iso', 'ce', 'ใบรับประกัน']):
            category = 'Warranty / Certificate'
            
        # 2. ถ้าชื่อไฟล์ไม่ได้บอก ให้ลองอ่านเนื้อหาในหน้าแรก
        if not category:
            try:
                reader = PdfReader(pdf_file)
                if len(reader.pages) > 0:
                    # ดึงข้อความ 500 ตัวอักษรแรกมาวิเคราะห์
                    text = reader.pages[0].extract_text()[:500].lower()
                    
                    if any(w in text for w in ['specification', 'spec sheet', 'dimensions', 'technical data']):
                        category = 'Spec Sheet / Data Sheet'
                    elif any(w in text for w in ['user manual', 'instruction manual', 'operating manual', 'operation manual', 'owner manual', 'instructions']):
                        category = 'User Manual / Operation Guide'
                    elif any(w in text for w in ['spare parts', 'parts list', 'exploded view', 'wiring diagram']):
                        category = 'Spare Parts / Diagram'
                    elif any(w in text for w in ['catalog', 'catalogue', 'brochure']):
                        category = 'Catalog / Brochure'
                    elif any(w in text for w in ['warranty', 'certificate', 'declaration of conformity']):
                        category = 'Warranty / Certificate'
            except Exception as e:
                pass
                
        if not category:
            category = 'Unknown / Other'
            
        categories_count[category] += 1
        
        if (idx + 1) % 100 == 0:
            print(f"วิเคราะห์ไปแล้ว {idx + 1}/{len(pdf_files)} ไฟล์...")

    print("-" * 40)
    print("ผลการจัดหมวดหมู่จากเนื้อหาไฟล์ทั้งหมด:")
    for cat, count in categories_count.most_common():
        print(f"- {cat}: {count} ไฟล์")

if __name__ == '__main__':
    classify_pdfs()
