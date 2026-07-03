import os
import csv
import re
import shutil

f80 = r'C:\Users\0125024\Pictures\image_product\set3-80'
f20 = r'C:\Users\0125024\Pictures\image_product\set3-20'
out_folder = r'C:\Users\0125024\Pictures\image_product\batch 3'
order_csv = r'c:\Users\0125024\Documents\shoptify\download\embedded_sku_order_batch_3.csv'

if not os.path.exists(out_folder):
    os.makedirs(out_folder)

skus = []
with open(order_csv, mode='r', encoding='utf-8-sig') as f:
    reader = csv.reader(f)
    next(reader)
    for row in reader:
        if row: skus.append(row[0])

def sanitize_filename(name):
    return re.sub(r'[<>:\"/\\|?*]', '_', name)

renamed = 0

def process_folder(folder, skus_subset):
    global renamed
    if not os.path.exists(folder):
        print(f"Folder not found: {folder}")
        return
        
    files = [f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f))]
    def extract_num(f):
        m = re.search(r'\d+', f)
        return int(m.group()) if m else 0
    files.sort(key=extract_num)
    
    for i, f in enumerate(files):
        if i < len(skus_subset):
            sku = skus_subset[i]
            safe_sku = sanitize_filename(sku)
            ext = os.path.splitext(f)[1]
            old_path = os.path.join(folder, f)
            new_path = os.path.join(out_folder, f'{safe_sku}{ext}')
            shutil.move(old_path, new_path)
            renamed += 1

process_folder(f80, skus[:80])
process_folder(f20, skus[80:])

print(f'Successfully renamed and merged {renamed} files into {out_folder}')
