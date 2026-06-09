import os
from dotenv import load_dotenv
import requests

load_dotenv(override=True)
shop = os.getenv('SHOP_NAME')
token = os.getenv('SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT')
url = f'https://{shop}/admin/api/2026-01/graphql.json'
headers = {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token}

query = """
query GetDefs($ownerType: MetafieldOwnerType!) {
  metafieldDefinitions(first: 250, ownerType: $ownerType) {
    nodes { namespace key type { name } }
  }
}
"""

r = requests.post(url, json={'query': query, 'variables': {'ownerType': 'PRODUCT'}}, headers=headers)
print('Status:', r.status_code)
import json
body = r.json()
print('Errors:', body.get('errors'))
nodes = body.get('data', {}).get('metafieldDefinitions', {}).get('nodes', [])
print('Definitions found:', len(nodes))
if nodes:
    print('Sample:', nodes[:3])
cost = body.get('extensions', {}).get('cost', {})
print('Cost:', cost)
