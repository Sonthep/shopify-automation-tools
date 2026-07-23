import os, requests, json
from dotenv import load_dotenv

load_dotenv('.env')
url = f'https://{os.environ["SHOP_NAME"]}/admin/api/2024-07/graphql.json'
headers = {'X-Shopify-Access-Token': os.environ['SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT'], 'Content-Type': 'application/json'}

q = '''
mutation {
  productVariantsBulkUpdate(productId: "gid://shopify/Product/8643843653831", variants: [
    {
      id: "gid://shopify/ProductVariant/46276171792583",
      price: "7600",
      compareAtPrice: "9500"
    }
  ]) {
    productVariants { price compareAtPrice }
    userErrors { field message }
  }
}
'''
res = requests.post(url, json={'query': q}, headers=headers)
print(json.dumps(res.json(), indent=2))
