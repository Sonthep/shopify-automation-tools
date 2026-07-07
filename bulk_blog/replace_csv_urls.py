import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath('.')))
from bulk_product.utils import read_csv_auto

df = read_csv_auto('data/sample_articles.csv')

# Map old URLs or fragments to new local paths
replacements = {
    "https://cdn.shopify.com/s/files/example/welcome-banner.jpg": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\welcome_banner_1783307322860.png",
    "https://chatgpt.com/backend-api/estuary/content?id=file_00000000928071fa90f14b7d21f3bbe1&ts=495361&p=fs&cid=1&sig=6a270dfd2e96577256140991fa3670dae103fe0348280fb7bf95453df74caeb9&v=0": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\restaurant_goals_featured_1783307333772.png",
    
    # Body images fragments (using unique IDs from the earlier task-84 log to map correctly, or just replacing sequentially if we don't have the exact ones. But let's look at the task-84 log again for the exact URLs in the body.)
    # Actually, we can just replace the 5 chatgpt URLs in the body based on the order or their unique id fragments.
    "file_00000000e27071fab5090b715e2e06ff": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\restaurant_goals_1_1783307342949.png", # Target/Goal
    "file_0000000015ac71fa84b74f2fca1bcd2e": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\digital_menu_2_1783307352454.png", # Menu
    "file_0000000079447207af4316c594df7c28": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\smart_pos_3_1783307364540.png", # POS
    "file_00000000c8d8720799ad0d976ecd9166": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\sales_report_4_1783307375422.png", # Report
    "file_00000000a90c7207b215c9e1b5c27194": r"C:\Users\0125024\.gemini\antigravity-ide\brain\53224997-e269-48f1-86fd-5b2e4db8dbe4\stock_management_5_1783307385499.png", # Stock
}

import pandas as pd
import re

def replace_in_text(text):
    if pd.isna(text): return text
    text = str(text)
    # First exact replacement for featured images
    if text in replacements:
        return replacements[text]
    
    # Then replacement for body html
    for frag, new_path in replacements.items():
        if frag in text:
            # We need to replace the entire URL that contains this fragment with the new path
            # Using regex to find the url inside src="..." that contains the fragment
            pattern = r'(https://chatgpt\.com/backend-api/estuary/content\?id=' + frag + r'[^"\']*)'
            text = re.sub(pattern, new_path.replace('\\', '\\\\'), text)
    return text

# Apply to all columns that might have URLs
for col in ['Image URL', 'Body', 'Body_TH']:
    if col in df.columns:
        df[col] = df[col].apply(replace_in_text)

df.to_csv('data/sample_articles_local_images.csv', index=False, encoding='utf-8-sig')
print("Saved to data/sample_articles_local_images.csv")
