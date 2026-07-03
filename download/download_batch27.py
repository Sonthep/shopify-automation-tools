import csv
import os
import urllib.request
import concurrent.futures

csv_file = r'c:\Users\0125024\Documents\shoptify\download\product_images_1_image_urls_batch27.csv'
output_dir = r'c:\Users\0125024\Documents\shoptify\download\images_batch27'

if not os.path.exists(output_dir):
    os.makedirs(output_dir)

req_headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
}

def download_image(row):
    if not row or len(row) < 4:
        return
    sku = row[0].strip()
    url = row[3].strip()
    
    if not url.startswith('http'):
        return
        
    try:
        req = urllib.request.Request(url, headers=req_headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            content_type = response.info().get('Content-Type')
            if content_type and 'image' in content_type:
                ext = '.jpg'
                if 'png' in content_type: ext = '.png'
                elif 'gif' in content_type: ext = '.gif'
                elif 'webp' in content_type: ext = '.webp'
                elif 'jpeg' in content_type: ext = '.jpg'
                
                valid_chars = "-_.() abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
                safe_sku = ''.join(c for c in sku if c in valid_chars)
                file_path = os.path.join(output_dir, f"{safe_sku}{ext}")
                
                with open(file_path, 'wb') as out_f:
                    out_f.write(response.read())
                print(f"Saved: {safe_sku}{ext}")
            else:
                pass # print(f"Skipped {sku}: Not an image")
    except Exception as e:
        pass # print(f"Failed {sku}: {e}")

def main():
    with open(csv_file, mode='r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        header = next(reader, None)
        rows = list(reader)

    print(f"Total rows to process: {len(rows)}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
        executor.map(download_image, rows)
    print("Download completed.")

if __name__ == '__main__':
    main()
