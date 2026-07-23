import os, requests, json
from dotenv import load_dotenv

load_dotenv('.env')
url = f'https://{os.environ["SHOP_NAME"]}/admin/api/2024-07/graphql.json'
headers = {'X-Shopify-Access-Token': os.environ['SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT'], 'Content-Type': 'application/json'}
q = '''
query {
  currentBulkOperation {
    id
    status
    url
  }
}
'''
res = requests.post(url, json={'query': q}, headers=headers)
op_url = res.json()['data']['currentBulkOperation']['url']
print('URL:', op_url)
if op_url:
    resp = requests.get(op_url)
    for line in resp.text.splitlines():
        if not line.strip(): continue
        try:
            data = json.loads(line)
            if 'data' in data and data['data'].get('productVariantsBulkUpdate', {}).get('userErrors'):
                print(data['data']['productVariantsBulkUpdate']['userErrors'])
        except Exception as e:
            pass
