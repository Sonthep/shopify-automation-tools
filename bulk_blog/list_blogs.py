import sys, os, importlib.util

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
UTILS_PATH = os.path.join(ROOT_DIR, "bulk_product", "utils.py")

spec = importlib.util.spec_from_file_location('utils', UTILS_PATH)
utils = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils)
headers = utils.make_headers('SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT')
result = utils.gql(utils.API_URL, headers, '{ blogs(first: 20) { edges { node { id title } } } }')
print("=== รายชื่อ Blog ทั้งหมดในร้าน ===")
for edge in result['data']['blogs']['edges']:
    n = edge['node']
    print(f"ID: {n['id']}  |  Title: {n['title']}")
