"""
export_folders_to_csv.py
อ่านโฟลเดอร์ SKU → บันทึกเป็น CSV (1 row = 1 folder)
โครงสร้างที่คาดหวัง:
  base_folder/
    SKU-001/
      image1.jpg
      image2.png
    SKU-002/
      image1.jpg

Output CSV format:
  SKU | Image Count | Image_1 | Image_2 | Image_3 | ...
"""

import os
import csv
import tkinter as tk
from tkinter import filedialog, messagebox

SUPPORTED_EXT = ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff')

DEFAULT_FOLDER = r"U:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69"


def get_images_in_folder(sku_path):
    """รวบรวมชื่อไฟล์ภาพทั้งหมดใน folder (รวม sub-folder)"""
    images = []
    for dirpath, _, filenames in os.walk(sku_path):
        for fname in sorted(filenames):
            if os.path.splitext(fname)[1].lower() in SUPPORTED_EXT:
                images.append(fname)
    return images


def export_to_csv():
    win = tk.Tk()
    win.withdraw()
    win.attributes('-topmost', True)

    # 1) เลือกโฟลเดอร์ต้นทาง
    folder_path = filedialog.askdirectory(
        title="📂 เลือกโฟลเดอร์หลัก (ที่มีโฟลเดอร์ SKU อยู่ข้างใน)",
        initialdir=DEFAULT_FOLDER if os.path.isdir(DEFAULT_FOLDER) else "/"
    )
    if not folder_path:
        win.destroy()
        return

    # 2) เลือกที่บันทึกไฟล์ CSV
    csv_path = filedialog.asksaveasfilename(
        title="💾 บันทึกไฟล์ CSV",
        defaultextension=".csv",
        filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        initialfile="sku_image_list.csv",
        initialdir=folder_path
    )
    if not csv_path:
        win.destroy()
        return

    count_sku = 0
    count_files = 0
    count_empty = 0
    max_images = 0

    # --- Pass 1: รวบรวมข้อมูลทั้งหมดก่อน เพื่อรู้จำนวน column สูงสุด ---
    rows = []
    entries = sorted(os.listdir(folder_path))
    for entry in entries:
        sku_path = os.path.join(folder_path, entry)
        if not os.path.isdir(sku_path):
            continue

        count_sku += 1
        images = get_images_in_folder(sku_path)

        if images:
            count_files += len(images)
            max_images = max(max_images, len(images))
        else:
            count_empty += 1

        rows.append({'sku': entry, 'images': images})

    # --- Pass 2: เขียน CSV ---
    try:
        with open(csv_path, mode='w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)

            # Header: SKU | Image Count | Image_1 | Image_2 | ...
            header = ['SKU (Folder Name)', 'Image Count'] + [f'Image_{i+1}' for i in range(max_images)]
            writer.writerow(header)

            for row in rows:
                sku = row['sku']
                images = row['images']
                img_count = len(images)
                # padding ด้วย '' ถ้า image น้อยกว่า max
                padded = images + [''] * (max_images - img_count)
                writer.writerow([sku, img_count] + padded)

        summary = (
            f"✅ บันทึกสำเร็จ!\n\n"
            f"📁 โฟลเดอร์ SKU ทั้งหมด  : {count_sku} โฟลเดอร์\n"
            f"🖼️  ไฟล์ภาพที่พบ          : {count_files} ไฟล์\n"
            f"⚠️  โฟลเดอร์ว่าง           : {count_empty} โฟลเดอร์\n"
            f"📊 คอลัมน์ภาพสูงสุด       : {max_images} คอลัมน์\n\n"
            f"📄 บันทึกที่:\n{csv_path}"
        )
        messagebox.showinfo("สำเร็จ", summary, parent=win)

    except PermissionError as e:
        messagebox.showerror("Permission Error", f"❌ ไม่มีสิทธิ์เข้าถึง:\n{e}", parent=win)
    except Exception as e:
        messagebox.showerror("Error", f"❌ เกิดข้อผิดพลาด:\n{e}", parent=win)
    finally:
        win.destroy()


if __name__ == "__main__":
    export_to_csv()
