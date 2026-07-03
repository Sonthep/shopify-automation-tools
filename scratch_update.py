import os, requests, json
from dotenv import load_dotenv

load_dotenv('.env')
url = f'https://{os.environ["SHOP_NAME"]}/admin/api/2024-07/graphql.json'
headers = {'X-Shopify-Access-Token': os.environ['SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT'], 'Content-Type': 'application/json'}

q = '''
mutation variantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants {
      id
      sku
    }
    userErrors {
      field
      message
    }
  }
}
'''
variables = {
    "productId": "gid://shopify/Product/8643843653831",
    "variants": [
        {
            "id": "gid://shopify/ProductVariant/46276171792583",
            "inventoryItem": {
                "sku": "NTS1-HLH1C"
            }
        }
    ]
}

res = requests.post(url, json={'query': q, 'variables': variables}, headers=headers)
print(json.dumps(res.json(), indent=2))
