import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath('.')))
from bulk_product.utils import read_csv_auto

df = read_csv_auto('data/sample_articles.csv')
img_tag_re = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*\balt=["\']([^"\']*)["\']', re.IGNORECASE)

print('Featured Images:')
for i, row in df.iterrows():
    url = row.get('Image URL')
    if pd.isna(url) or not str(url).strip(): continue
    alt = row.get('Image Alt', 'Featured image')
    print(f"Title: {row.get('Title')}\nAlt: {alt}\nURL: {url}\n")

print('Body Images:')
import pandas as pd
for i, row in df.iterrows():
    title = row.get('Title')
    body_th = str(row.get('Body_TH', ''))
    body = str(row.get('Body', ''))
    found = img_tag_re.findall(body_th) + img_tag_re.findall(body)
    for url, alt in found:
        print(f"Title: {title}\nAlt: {alt}\nURL: {url}\n")
