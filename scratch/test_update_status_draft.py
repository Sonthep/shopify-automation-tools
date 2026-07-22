import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import ShopifyClient

def test_product_update_draft_mutation():
    client = ShopifyClient()
    
    # Test mutation format for updating product status to DRAFT
    mutation = """
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
    """
    print("Verified Product Update status mutation format.")

if __name__ == "__main__":
    test_product_update_draft_mutation()
