import pandas as pd
import re

df = pd.read_csv('data/sample_articles_ready.csv', encoding='utf-8')
cdn_url = 'https://cdn.shopify.com/s/files/1/0766/9976/2887/files/restaurant_goals_featured_1783307333772.jpg'

def fix_url(text):
    if pd.isna(text): return text
    text = str(text)
    # Match https://chatgpt.com... up to the next quote
    return re.sub(r'https://chatgpt\.com[^\'"]+', cdn_url, text)

df['Body_TH'] = df['Body_TH'].apply(fix_url)
df['Body'] = df['Body'].apply(fix_url)

df.to_csv('data/sample_articles_ready.csv', index=False, encoding='utf-8-sig')
print("Fixed!")
