"""
delete_folders.py / delete_folders_from_csv.py
-------------------------------------------------------------------------------
สคริปต์ลบ sub-folder ใน main folder ตามรายชื่อจากไฟล์ CSV

อินพุตที่รับ (2 อย่าง):
1. Main Folder: โฟลเดอร์หลักที่บรรจุโฟลเดอร์ย่อย (เช่น W:\\25.WEBSITE\\...\\รูปภาพอะไหล่ 09-07-69)
2. CSV File: ไฟล์ CSV ที่ระบุรายชื่อ sub-folder / SKU ที่ต้องการลบ

การใช้งาน (Usage):
  py delete_folders.py                   (รันแล้วกรอก 2 อินพุตตามตัวเลือก)
  py delete_folders.py --main-folder "W:\\path\\to\\main" --csv "list.csv"
  py delete_folders.py --main-folder "W:\\path\\to\\main" --csv "list.csv" --confirm
-------------------------------------------------------------------------------
"""

import os
import sys
import csv
import shutil
import argparse

# บังคับใช้ UTF-8 output บน Windows terminal
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ค่าเริ่มต้นสำหรับ Main Folder
DEFAULT_MAIN_FOLDERS = [
    r"W:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69",
    r"U:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69",
]

POSSIBLE_COLUMNS = [
    "folder", "folder_path", "folder path", "foldername", "folder_name",
    "sku", "variant sku", "sku_name", "directory", "dir", "path", "name"
]


def get_default_main_folder() -> str:
    for p in DEFAULT_MAIN_FOLDERS:
        if os.path.exists(p):
            return p
    return DEFAULT_MAIN_FOLDERS[0]


def clean_input_path(path_str: str) -> str:
    """ลบอัญประกาศตัวหนาคู่/เดี่ยวจากการลากวางไฟล์ใน Windows terminal"""
    if not path_str:
        return ""
    return path_str.strip().strip('"').strip("'").strip()


def read_csv_auto(csv_path: str) -> tuple[list[dict], str]:
    """อ่าน CSV โดยลองหลาย encoding และส่งคืน (rows, column_name_used)"""
    encodings = ["utf-8-sig", "cp874", "utf-8", "latin-1"]
    content = None

    for enc in encodings:
        try:
            with open(csv_path, mode="r", encoding=enc) as f:
                reader = list(csv.DictReader(f))
                if reader:
                    content = reader
                    break
        except (UnicodeDecodeError, Exception):
            continue

    if content is None:
        for enc in encodings:
            try:
                with open(csv_path, mode="r", encoding=enc) as f:
                    reader = list(csv.reader(f))
                    if reader:
                        content = [{"col_0": row[0].strip()} for row in reader if row]
                        return content, "col_0"
            except (UnicodeDecodeError, Exception):
                continue
        raise ValueError(f"ไม่สามารถอ่านไฟล์ CSV ได้: {csv_path}")

    headers = list(content[0].keys())
    matched_col = None
    for h in headers:
        if h and h.strip().lower() in POSSIBLE_COLUMNS:
            matched_col = h
            break

    if not matched_col:
        matched_col = headers[0]

    return content, matched_col


def safe_is_subpath(path: str, base_dir: str) -> bool:
    """ตรวจสอบว่า path อยู่ใต้ base_dir หรือไม่ (ป้องกันลบผิดโฟลเดอร์สำคัญ)"""
    try:
        abs_path = os.path.realpath(path)
        abs_base = os.path.realpath(base_dir)
        return os.path.commonpath([abs_path, abs_base]) == abs_base
    except Exception:
        return False


def prompt_inputs(cli_main_folder: str | None, cli_csv: str | None) -> tuple[str, str]:
    """รับ 2 อินพุต: 1. Main Folder 2. CSV Sub-folder list"""
    default_main = get_default_main_folder()

    print("=" * 75)
    print(" 🗑️  Delete Sub-Folders from CSV Script")
    print("=" * 75)

    # ---------------- 1. รับค่า Main Folder ----------------
    main_folder = clean_input_path(cli_main_folder)
    if not main_folder:
        print(f"\n📂 [Input 1/2] กรุณาใส่/ลากวาง Main Folder (โฟลเดอร์หลัก):")
        print(f"   (กด Enter เพื่อใช้ค่าเริ่มต้น: {default_main})")
        user_input_main = input("👉 Main Folder Path: ")
        user_input_main = clean_input_path(user_input_main)
        main_folder = user_input_main if user_input_main else default_main

    while not os.path.exists(main_folder):
        print(f"❌ Error: ไม่พบโฟลเดอร์หลัก '{main_folder}'")
        user_input_main = input("👉 โปรดป้อน Main Folder ใหม่: ")
        main_folder = clean_input_path(user_input_main)
        if not main_folder:
            sys.exit(1)

    # ---------------- 2. รับค่า CSV File ----------------
    csv_file = clean_input_path(cli_csv)
    default_csv = "../data/delete_folder_image_20769.csv"

    if not csv_file:
        print(f"\n📄 [Input 2/2] กรุณาใส่/ลากวาง CSV File (ไฟล์รายชื่อ sub-folder ที่จะลบ):")
        if os.path.exists(default_csv):
            print(f"   (กด Enter เพื่อใช้ค่าเริ่มต้น: {default_csv})")
        user_input_csv = input("👉 CSV File Path: ")
        user_input_csv = clean_input_path(user_input_csv)
        
        if not user_input_csv and os.path.exists(default_csv):
            csv_file = default_csv
        else:
            csv_file = user_input_csv

    while not csv_file or not os.path.exists(csv_file):
        print(f"❌ Error: ไม่พบไฟล์ CSV '{csv_file}'")
        user_input_csv = input("👉 โปรดป้อน CSV File Path ใหม่: ")
        csv_file = clean_input_path(user_input_csv)
        if not csv_file:
            sys.exit(1)

    return main_folder, csv_file


def main():
    parser = argparse.ArgumentParser(description="Delete sub-folders from CSV within a Main Folder.")
    parser.add_argument("-m", "--main-folder", "--base-dir", type=str, help="Path to Main Folder containing sub-folders")
    parser.add_argument("-c", "--csv", type=str, help="Path to CSV file containing sub-folders/SKUs to delete")
    parser.add_argument("--col", type=str, help="Column name in CSV containing folder names/paths")
    parser.add_argument("-y", "--confirm", action="store_true", help="Skip confirmation prompt and delete directly")
    args = parser.parse_args()

    # รับค่า 2 อินพุต (Main Folder และ CSV File)
    main_folder, csv_path = prompt_inputs(args.main_folder, args.csv)

    print("\n" + "-" * 75)
    print(f"📖 กำลังอ่านไฟล์ CSV  : {csv_path}")
    rows, target_col = read_csv_auto(csv_path)
    if args.col:
        target_col = args.col

    print(f"📍 Main Folder (หลัก) : {main_folder}")
    print(f"📌 คอลัมน์ที่ใช้งาน CSV : '{target_col}' (จำนวนรายการ: {len(rows)} แถว)")

    to_delete = []
    not_found = []
    skipped_unsafe = []

    for r in rows:
        val = r.get(target_col, "").strip()
        if not val:
            continue

        if os.path.isabs(val):
            target_path = os.path.abspath(val)
        else:
            target_path = os.path.abspath(os.path.join(main_folder, val))

        # ตรวจสอบความปลอดภัย
        if target_path in [os.path.abspath("\\"), os.path.abspath("C:\\"), os.path.expanduser("~")]:
            skipped_unsafe.append(target_path)
            continue

        if not safe_is_subpath(target_path, main_folder):
            skipped_unsafe.append(target_path)
            continue

        if os.path.exists(target_path) and os.path.isdir(target_path):
            to_delete.append(target_path)
        else:
            not_found.append(target_path)

    # แสดงรายงาน Preview
    print("=" * 75)
    print(" 📋 รายงานสรุปการตรวจสอบโฟลเดอร์ (Deletion Preview)")
    print("=" * 75)
    print(f" ✅ Sub-folders ที่พบและพร้อมลบ  : {len(to_delete)} โฟลเดอร์")
    print(f" ❓ Sub-folders ที่ไม่พบในระบบ   : {len(not_found)} โฟลเดอร์")
    if skipped_unsafe:
        print(f" ⚠️  ข้ามโฟลเดอร์ไม่ปลอดภัย        : {len(skipped_unsafe)} โฟลเดอร์")
    print("-" * 75)

    if not to_delete:
        print("⚠️ ไม่พบ sub-folder ที่ต้องลบตามรายชื่อใน CSV")
        sys.exit(0)

    print("ตัวอย่าง sub-folders ที่จะถูกลบ:")
    for p in to_delete[:10]:
        print(f"  - {p}")
    if len(to_delete) > 10:
        print(f"  ... และอีก {len(to_delete) - 10} โฟลเดอร์")
    print("-" * 75)

    # ยืนยันการลบ
    if not args.confirm:
        confirm = input(f"🚨 แน่ใจหรือไม่ว่าต้องการลบ {len(to_delete)} sub-folders ใน Main Folder? (พิมพ์ 'yes' เพื่อยืนยัน): ").strip().lower()
        if confirm != "yes":
            print("❌ ยกเลิกการลบ (ไม่มีไฟล์ใดๆ ถูกลบ)")
            sys.exit(0)

    # ดำเนินการลบจริง
    deleted_count = 0
    err_count = 0
    print("\n🗑️  กำลังดำเนินการลบ sub-folders...")
    for idx, path in enumerate(to_delete, start=1):
        try:
            shutil.rmtree(path)
            deleted_count += 1
            print(f"  [{idx}/{len(to_delete)}] Deleted: {path}")
        except Exception as exc:
            err_count += 1
            print(f"  [{idx}/{len(to_delete)}] ❌ Failed to delete {path}: {exc}")

    print("=" * 75)
    print("🎉 การลบเสร็จสิ้น!")
    print(f" 🗑️ ลบสำเร็จ   : {deleted_count} โฟลเดอร์")
    if err_count > 0:
        print(f" ❌ ลบไม่สำเร็จ : {err_count} โฟลเดอร์")
    print("=" * 75)


if __name__ == "__main__":
    main()
