"""
copy_and_merge_images.py
-------------------------------------------------------------------------------
สคริปต์สำหรับคัดลอกและรวมรูปภาพ (Merge Images) จากโฟลเดอร์เครือข่าย W:/U:
โดย **คัดลอกออกมาเท่านั้น** ไม่แก้ไขหรือลบไฟล์ต้นฉบับใน Network Drive

โครงสร้างไฟล์ต้นทาง (Source):
  W:/25.WEBSITE/Sp_Website/รูปภาพอะไหล่ 09-07-69/รูปภาพอะไหล่ 09-07-69/
    ├── SKU-001/
    │     ├── 451242_0.jpg
    │     └── 451243_0.jpg
    └── SKU-002/
          └── 446328.jpg

โครงสร้างไฟล์ปลายทาง (Destination - Default: Flat Mode สำหรับ Shopify):
  C:/Users/0125024/Pictures/image_product/merged_09_07_69/
    ├── SKU-001.jpg
    ├── SKU-001 (2).jpg
    └── SKU-002.jpg

การใช้งาน (Usage):
  python copy_and_merge_images.py
  python copy_and_merge_images.py --out "C:\\path\\to\\custom_folder"
  python copy_and_merge_images.py --keep-folders  (คัดลอกแบบคงโครงสร้างโฟลเดอร์ SKU ไว้)
-------------------------------------------------------------------------------
"""

import os
import sys
import shutil
import argparse
import re

# บังคับใช้ UTF-8 output บน Windows terminal
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# โฟลเดอร์ต้นทาง (ลอง W: ก่อน ถ้าไม่มีสลับไป U:)
SRC_PATHS = [
    r"W:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69",
    r"U:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69",
]

DEFAULT_DEST = r"C:\Users\0125024\Pictures\image_product\merged_09_07_69"
SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp", ".tif", ".tiff"}


def sanitize_filename(name: str) -> str:
    """ทำความสะอาดชื่อไฟล์ ห้ามมีตัวอักษรพิเศษของระบบไฟล์"""
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()


def find_source_folder() -> str | None:
    """หาโฟลเดอร์ต้นทางที่มีอยู่จริง"""
    for p in SRC_PATHS:
        if os.path.exists(p):
            return p
    return None


def copy_and_merge(src_dir: str, dest_dir: str, keep_folders: bool = False):
    print("=" * 70)
    print(" 📂 Image Copy & Merge Script (Safety Copy - Original Intact)")
    print("=" * 70)
    print(f"📍 Source Folder     : {src_dir}")
    print(f"💾 Destination Folder: {dest_dir}")
    print(f"⚙️  Copy Mode         : {'Keep Subfolders' if keep_folders else 'Flat SKU Renamed (Shopify Ready)'}")
    print("-" * 70)

    if not os.path.exists(dest_dir):
        os.makedirs(dest_dir, exist_ok=True)
        print(f"✨ Created destination folder: {dest_dir}")

    total_skus = 0
    total_images_copied = 0
    skipped_files = 0
    errors = []

    # ดึงรายการโฟลเดอร์ SKU ในต้นทาง
    items = sorted(os.listdir(src_dir))

    for item in items:
        sku_folder_path = os.path.join(src_dir, item)
        
        # ถ้ารายการเป็นไฟล์ใน root หรือ Thumbs.db ให้ข้าม
        if not os.path.isdir(sku_folder_path):
            continue

        sku = sanitize_filename(item)
        
        # ค้นหารูปภาพทั้งหมดใน SKU folder (เรียงตามชื่อไฟล์)
        all_files = sorted(os.listdir(sku_folder_path))
        img_files = [f for f in all_files if os.path.splitext(f)[1].lower() in SUPPORTED_EXTS]

        if not img_files:
            continue

        total_skus += 1

        if keep_folders:
            # Mode A: คงโฟลเดอร์ SKU ไว้ที่ปลายทาง
            target_sku_dir = os.path.join(dest_dir, sku)
            os.makedirs(target_sku_dir, exist_ok=True)
            
            for f in img_files:
                src_file = os.path.join(sku_folder_path, f)
                dst_file = os.path.join(target_sku_dir, f)
                try:
                    shutil.copy2(src_file, dst_file)
                    total_images_copied += 1
                except Exception as e:
                    errors.append((src_file, str(e)))
        else:
            # Mode B: รวมไฟล์เข้าในโฟลเดอร์เดียว ตั้งชื่อไฟล์ตาม SKU (SKU.jpg, SKU (2).jpg, ...)
            for idx, f in enumerate(img_files, start=1):
                ext = os.path.splitext(f)[1].lower()
                src_file = os.path.join(sku_folder_path, f)

                if idx == 1:
                    new_filename = f"{sku}{ext}"
                else:
                    new_filename = f"{sku} ({idx}){ext}"

                dst_file = os.path.join(dest_dir, new_filename)

                try:
                    shutil.copy2(src_file, dst_file)
                    total_images_copied += 1
                except Exception as e:
                    errors.append((src_file, str(e)))

        print(f"  ✅ [SKU {total_skus}] {sku:30s} -> Copied {len(img_files)} image(s)")

    print("-" * 70)
    print("🎉 Copy & Merge Completed!")
    print(f"📊 Total SKUs Processed : {total_skus}")
    print(f"🖼️  Total Images Copied  : {total_images_copied}")
    if errors:
        print(f"⚠️  Errors ({len(errors)}):")
        for src, err in errors[:5]:
            print(f"   - {src}: {err}")
    print(f"📁 Destination Folder    : {os.path.abspath(dest_dir)}")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Copy and merge images from SKU subfolders.")
    parser.add_argument("--src", type=str, help="Source directory containing SKU folders")
    parser.add_argument("--out", type=str, default=DEFAULT_DEST, help="Destination output directory")
    parser.add_argument("--keep-folders", action="store_true", help="Keep SKU subfolders instead of flattening")
    args = parser.parse_args()

    src = args.src or find_source_folder()

    if not src or not os.path.exists(src):
        print("❌ Error: Could not find source folder!")
        print(f"   Checked paths: {SRC_PATHS}")
        sys.exit(1)

    copy_and_merge(src_dir=src, dest_dir=args.out, keep_folders=args.keep_folders)


if __name__ == "__main__":
    main()
