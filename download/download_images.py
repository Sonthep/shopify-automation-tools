import csv
import os
import urllib.request
from urllib.error import URLError, HTTPError

csv_file = r'c:\Users\0125024\Documents\shoptify\bulk-update-product\data\cambro_image.csv'
output_dir = r'c:\Users\0125024\Documents\shoptify\download\images'

if not os.path.exists(output_dir):
    os.makedirs(output_dir)

req_headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

with open(csv_file, mode='r', encoding='utf-8') as f:
    reader = csv.reader(f)
    header = next(reader)
    for row in reader:
        if not row:
            continue
        sku = row[0]
        url = row[1]
        
        if url.strip():
            print(f"Downloading {sku} from {url} ...")
            try:
                req = urllib.request.Request(url, headers=req_headers)
                with urllib.request.urlopen(req) as response:
                    content_type = response.info().get('Content-Type')
                    if content_type and 'image' in content_type:
                        # Determine extension
                        ext = '.jpg'
                        if 'png' in content_type: ext = '.png'
                        elif 'gif' in content_type: ext = '.gif'
                        elif 'webp' in content_type: ext = '.webp'
                        
                        file_path = os.path.join(output_dir, f"{sku}{ext}")
                        with open(file_path, 'wb') as out_f:
                            out_f.write(response.read())
                        print(f"  -> Saved to {file_path}")
                    else:
                        print(f"  -> Skipped: URL does not point directly to an image (Content-Type: {content_type})")
            except Exception as e:
                print(f"  -> Failed: {e}")
