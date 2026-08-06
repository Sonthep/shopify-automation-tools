import json
import requests
from collections import Counter

url = "https://storage.googleapis.com/shopify-tiers-assets-prod-us-east1/bulk-operation-outputs/f0aa624d56280b9713d839606f7f?GoogleAccessId=assets-us-prod%40shopify-tiers.iam.gserviceaccount.com&Expires=1786591444&Signature=Zl47P3fDpNqr6%2Bb0GZ0SM3PKMlHRcITFznxBR4Osy8O1h7854rdMN0b9cyZAGpc5Mr8g%2BtVczttT4L9pfnPq%2FLySjfqaVC4yJVGnE9UUcA3Bt0NyhBx7gZ7GNKI90n9Dk2y7x7MOdvPbKX7tPEyyqZanYQtbYfeoKHswYeTzK1MP4mZ9zXajZaoFHNsIkZe1C04w%2FTO7S1XTW7iW%2Fr%2FWVkcG%2FIL0HNuuIn%2FVX5fxVh5llBjKZ4Ait3FqHWhUihbH1C1LYCme6EoRDUCx%2F7fUg%2B4S4Zk61lfPafdmYHauwOqgQppY2wIz5OZYFmUI0Y5FDjiZ3mw2z6S0TYXIhSXCzA%3D%3D&response-content-disposition=attachment%3B+filename%3D%22staging-bulk-7339113840839.jsonl%22%3B+filename%2A%3DUTF-8%27%27staging-bulk-7339113840839.jsonl&response-content-type=application%2Fjsonl"

r = requests.get(url)
lines = r.text.strip().split('\n')
print(f"Total lines: {len(lines)}")

counter = Counter()
products = set()
variants = set()

for line in lines:
    if not line.strip(): continue
    obj = json.loads(line)
    gid = obj.get("id", "")
    parent = obj.get("__parentId", "")
    
    if "/Product/" in gid and not parent:
        counter["Product"] += 1
        products.add(gid)
    elif "/ProductVariant/" in gid:
        counter["ProductVariant"] += 1
        variants.add(gid)
    elif "/ProductImage/" in gid or "/Image/" in gid:
        counter["Image"] += 1
    elif "namespace" in obj:
        counter["Metafield"] += 1
    else:
        counter["Other"] += 1

print("Counts by type:")
for k, v in counter.items():
    print(f"  {k}: {v}")

print(f"Unique products: {len(products)}")
print(f"Unique variants: {len(variants)}")
