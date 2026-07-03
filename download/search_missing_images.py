import csv
import os
import shutil
import re

csv_file = r'c:\Users\0125024\Documents\shoptify\download\product_images_1_image_urls_batch27.csv'
output_dir = r'c:\Users\0125024\Documents\shoptify\download\image_form_abroad'
search_dir = r'T:\#ต่างประเทศ'

if not os.path.exists(output_dir):
    os.makedirs(output_dir)

missing_items = []
with open(csv_file, mode='r', encoding='utf-8-sig') as f:
    reader = csv.reader(f)
    header = next(reader, None)
    for row in reader:
        if not row or len(row) < 4:
            continue
        sku = row[0].strip()
        url = row[3].strip()
        status = row[4].strip() if len(row) > 4 else ""
        
        # Consider missing if URL is empty, status is 'ไม่พบ', or no http
        if not url or status == 'ไม่พบ' or not url.startswith('http'):
            # Strip prefix (everything up to the first '-')
            if '-' in sku:
                prefix, search_term = sku.split('-', 1)
            else:
                search_term = sku
            
            missing_items.append({
                'sku': sku,
                'search_term': search_term.lower()
            })

print(f"Found {len(missing_items)} missing items in CSV.")

image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
print(f"Scanning {search_dir} for matching files...")
matched_count = 0

for root, dirs, files in os.walk(search_dir):
    for filename in files:
        ext = os.path.splitext(filename)[1].lower()
        if ext not in image_extensions:
            continue
            
        name_lower = filename.lower()
        name_no_ext = os.path.splitext(name_lower)[0]
        
        for item in missing_items:
            search_term = item['search_term']
            
            # Simple heuristic: exact match, or search_term is surrounded by non-alphanumeric chars
            # E.g., if search_term is '104', it matches '104.jpg', '104-1.jpg', 'pic 104.jpg' but not '2104.jpg'
            # To implement this easily:
            pattern = r'(^|[^a-z0-9])' + re.escape(search_term) + r'([^a-z0-9]|$)'
            if re.search(pattern, name_no_ext):
                full_sku = item['sku']
                src_path = os.path.join(root, filename)
                dest_path = os.path.join(output_dir, f"{full_sku}{ext}")
                
                if not os.path.exists(dest_path):
                    try:
                        shutil.copy2(src_path, dest_path)
                        print(f"Matched {full_sku} (search: {search_term}) -> copied {filename}")
                        matched_count += 1
                        item['found'] = True
                    except Exception as e:
                        print(f"Failed to copy {src_path}: {e}")
                
        # Filter out found items
        missing_items = [i for i in missing_items if not i.get('found')]
        
        if not missing_items:
            break
    if not missing_items:
        break

print(f"Finished. Found and copied {matched_count} images.")
