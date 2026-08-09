import os
import shutil
import hashlib
from pathlib import Path

def get_file_hash(filepath):
    """Calculate MD5 hash of a file."""
    hash_md5 = hashlib.md5()
    with open(filepath, "rb") as f:
        # Read file in chunks to handle large files efficiently
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

def remove_duplicate_pdfs():
    source_folder = Path("Found_PDFs")
    duplicates_folder = source_folder / "Duplicates"
    
    if not source_folder.exists():
        print(f"Folder {source_folder} does not exist.")
        return

    # สร้างโฟลเดอร์สำหรับเก็บไฟล์ซ้ำ
    duplicates_folder.mkdir(exist_ok=True)
    
    seen_hashes = {}
    duplicate_count = 0
    total_count = 0

    print("กำลังตรวจสอบและลบไฟล์ที่เนื้อหาซ้ำกัน...")
    
    # ดึงเฉพาะไฟล์ .pdf ที่อยู่ในโฟลเดอร์หลัก (ไม่รวมโฟลเดอร์ย่อย)
    pdf_files = [f for f in source_folder.glob("*.pdf") if f.is_file()]
    
    for pdf_file in pdf_files:
        total_count += 1
        file_hash = get_file_hash(pdf_file)
        
        # ถ้าเคยเจอ hash นี้แล้ว แปลว่าเป็นไฟล์ซ้ำแน่ๆ (แม้ชื่อจะต่างกัน)
        if file_hash in seen_hashes:
            duplicate_count += 1
            dest_file = duplicates_folder / pdf_file.name
            
            try:
                # ถ้ามีไฟล์ชื่อเดียวกันอยู่แล้วใน Duplicates ให้ลบก่อน
                if dest_file.exists():
                    dest_file.unlink()
                # ย้ายไฟล์ที่ซ้ำออกไป
                shutil.move(str(pdf_file), str(dest_file))
                print(f"[Duplicate] ย้ายไฟล์ซ้ำ: {pdf_file.name} (ซ้ำกับ {seen_hashes[file_hash]})")
            except Exception as e:
                print(f"[Error] ไม่สามารถย้ายไฟล์ {pdf_file.name}: {e}")
        else:
            # บันทึกไว้ว่าไฟล์ hash นี้เจอครั้งแรกที่ชื่อไฟล์อะไร
            seen_hashes[file_hash] = pdf_file.name

    print("-" * 40)
    print(f"ตรวจสอบทั้งหมด: {total_count} ไฟล์")
    print(f"พบไฟล์ที่เนื้อหาซ้ำกันเป๊ะๆ และถูกย้ายออก: {duplicate_count} ไฟล์")
    print(f"เหลือไฟล์ที่ไม่ซ้ำกัน: {total_count - duplicate_count} ไฟล์")
    print(f"ไฟล์ที่ซ้ำกันถูกแยกไปไว้ที่: {duplicates_folder.absolute()}")

if __name__ == '__main__':
    remove_duplicate_pdfs()
