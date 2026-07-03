import os
import csv
import re

batch_folder = r'C:\Users\0125024\Pictures\image_product\batch 1'
order_csv = r'c:\Users\0125024\Documents\shoptify\download\embedded_sku_order_batch_1.csv'

if not os.path.exists(batch_folder):
    print(f'Folder not found: {batch_folder}')
    exit()

if not os.path.exists(order_csv):
    print(f'CSV not found: {order_csv}')
    exit()

skus = []
with open(order_csv, mode='r', encoding='utf-8-sig') as f:
    reader = csv.reader(f)
    next(reader) 
    for row in reader:
        if row:
            skus.append(row[0])

files = [f for f in os.listdir(batch_folder) if os.path.isfile(os.path.join(batch_folder, f))]
def extract_num(f):
    m = re.search(r'\d+', f)
    return int(m.group()) if m else 0

files.sort(key=extract_num)

if len(files) != len(skus):
    print(f'Warning: Number of files ({len(files)}) does not match number of SKUs ({len(skus)})')

def sanitize_filename(name):
    return re.sub(r'[<>:\"/\\|?*]', '_', name)

renamed = 0
for i, f in enumerate(files):
    if i < len(skus):
        sku = skus[i]
        safe_sku = sanitize_filename(sku)
        ext = os.path.splitext(f)[1]
        
        old_path = os.path.join(batch_folder, f)
        new_path = os.path.join(batch_folder, f'{safe_sku}{ext}')
        
        try:
            os.rename(old_path, new_path)
            renamed += 1
        except Exception as e:
            print(f'Failed to rename {f} to {safe_sku}{ext}: {e}')

print(f'Successfully renamed {renamed} files.')
