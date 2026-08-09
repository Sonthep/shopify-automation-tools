import os
import shutil
from pathlib import Path
from pypdf import PdfReader

def check_and_move_corrupted_pdfs():
    source_folder = Path("Found_PDFs")
    corrupted_folder = source_folder / "Corrupted_PDFs"
    
    if not source_folder.exists():
        print(f"Folder {source_folder} does not exist.")
        return

    # สร้างโฟลเดอร์สำหรับเก็บไฟล์ที่เปิดไม่ได้
    corrupted_folder.mkdir(exist_ok=True)
    
    corrupted_count = 0
    total_count = 0

    print("กำลังตรวจสอบไฟล์ PDF ทั้งหมด...")
    for pdf_file in source_folder.glob("*.pdf"):
        total_count += 1
        is_corrupted = False
        
        # 1. เช็คขนาดไฟล์
        if pdf_file.stat().st_size == 0:
            is_corrupted = True
        else:
            # 2. ลองใช้ pypdf ตรวจสอบว่าเปิดได้ไหม
            try:
                reader = PdfReader(pdf_file)
                # ลองเข้าถึงหน้าแรกเพื่อดูว่าพังไหม
                if len(reader.pages) > 0:
                    _ = reader.pages[0]
            except Exception as e:
                is_corrupted = True

        # ถ้าย้ายไฟล์
        if is_corrupted:
            corrupted_count += 1
            dest_file = corrupted_folder / pdf_file.name
            try:
                # ถ้ามีไฟล์ซ้ำในโฟลเดอร์ปลายทางแล้ว ลบก่อน
                if dest_file.exists():
                    dest_file.unlink()
                # ย้ายไฟล์
                shutil.move(str(pdf_file), str(dest_file))
                print(f"[Corrupted] ย้ายไฟล์เปิดไม่ได้: {pdf_file.name}")
            except Exception as e:
                print(f"[Error] ไม่สามารถย้ายไฟล์ {pdf_file.name}: {e}")

    print("-" * 40)
    print(f"ตรวจสอบทั้งหมด: {total_count} ไฟล์")
    print(f"พบไฟล์ที่เปิดไม่ได้และถูกย้าย: {corrupted_count} ไฟล์")
    print(f"ไฟล์ที่เปิดไม่ได้ถูกเก็บไว้ที่: {corrupted_folder.absolute()}")

if __name__ == '__main__':
    check_and_move_corrupted_pdfs()
