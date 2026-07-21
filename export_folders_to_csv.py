"""
export_folders_to_csv.py
-------------------------------------------------------------------------------
ส่งออกรายชื่อ Sub-folder ทั้งหมดใน Main Folder ออกมาเป็นไฟล์ CSV (คอลัมน์ `sku` เพียงอย่างเดียว)

Output CSV format:
  sku
  PIM2-DR520TT-5-9
  PIM2-DR520TT-10-28
  SIR2-19363560
  ...

การใช้งาน (Usage):
  python export_folders_to_csv.py
  python export_folders_to_csv.py --folder "W:\\path\\to\\main" --out "subfolder_list.csv"
-------------------------------------------------------------------------------
"""

import os
import sys
import csv
import argparse
import tkinter as tk
from tkinter import filedialog, messagebox

# บังคับใช้ UTF-8 output บน Windows terminal
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_FOLDERS = [
    r"W:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69",
    r"U:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69",
]


def find_default_folder() -> str:
    for p in DEFAULT_FOLDERS:
        if os.path.exists(p):
            return p
    return "/"


def export_subfolders_to_csv(folder_path: str, csv_path: str, interactive: bool = False):
    """ส่งออกชื่อ sub-folder ทั้งหมดเป็น CSV (1 คอลัมน์: sku)"""
    if not os.path.isdir(folder_path):
        print(f"❌ Error: ไม่พบโฟลเดอร์หลัก '{folder_path}'")
        return

    # ค้นหา sub-folders ทั้งหมด
    entries = sorted(os.listdir(folder_path))
    subfolders = [entry for entry in entries if os.path.isdir(os.path.join(folder_path, entry))]

    try:
        with open(csv_path, mode="w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            # เขียน Header แค่ `sku` อย่างเดียว
            writer.writerow(["sku"])
            for sub in subfolders:
                writer.writerow([sub])

        summary = (
            f"✅ ส่งออกรายชื่อ sub-folder สำเร็จ!\n\n"
            f"📂 โฟลเดอร์หลัก: {folder_path}\n"
            f"📊 จำนวน sub-folder ทั้งหมด: {len(subfolders)} รายการ\n"
            f"📄 บันทึกที่: {csv_path}"
        )
        print("=" * 70)
        print(summary)
        print("=" * 70)

        if interactive:
            win = tk.Tk()
            win.withdraw()
            win.attributes("-topmost", True)
            messagebox.showinfo("สำเร็จ", summary, parent=win)
            win.destroy()

    except Exception as e:
        print(f"❌ เกิดข้อผิดพลาดในการบันทึก CSV: {e}")
        if interactive:
            win = tk.Tk()
            win.withdraw()
            win.attributes("-topmost", True)
            messagebox.showerror("Error", f"เกิดข้อผิดพลาด:\n{e}", parent=win)
            win.destroy()


def main():
    parser = argparse.ArgumentParser(description="Export subfolder names from main folder to CSV.")
    parser.add_argument("--folder", "-f", type=str, help="Main folder containing subfolders")
    parser.add_argument("--out", "-o", type=str, help="Destination CSV file path")
    args = parser.parse_args()

    folder_path = args.folder
    csv_path = args.out
    interactive = False

    # หากรันโดยไม่มี argument ให้เปิดหน้าต่างเลือกไฟล์/โฟลเดอร์ (GUI Dialog)
    if not folder_path or not csv_path:
        interactive = True
        win = tk.Tk()
        win.withdraw()
        win.attributes("-topmost", True)

        default_dir = find_default_folder()

        if not folder_path:
            folder_path = filedialog.askdirectory(
                title="📂 เลือกโฟลเดอร์หลัก (Main Folder)",
                initialdir=default_dir if os.path.isdir(default_dir) else "/"
            )
            if not folder_path:
                win.destroy()
                print("❌ ยกเลิก: ไม่ได้เลือกโฟลเดอร์หลัก")
                return

        if not csv_path:
            csv_path = filedialog.asksaveasfilename(
                title="💾 บันทึกไฟล์ CSV",
                defaultextension=".csv",
                filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
                initialfile="subfolder_list.csv",
                initialdir=folder_path
            )
            if not csv_path:
                win.destroy()
                print("❌ ยกเลิก: ไม่ได้เลือกสถานที่บันทึก CSV")
                return

        win.destroy()

    export_subfolders_to_csv(folder_path, csv_path, interactive=interactive)


if __name__ == "__main__":
    main()
