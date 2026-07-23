import os
import sys
import re
import requests
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")

def generate_token(env_path: str = ENV_PATH) -> str | None:
    """Fetch a new Shopify Access Token using Client Credentials and update .env."""
    load_dotenv(dotenv_path=env_path, override=True)
    
    shop = os.getenv("SHOP_NAME", "sevenfive-4062.myshopify.com").replace("https://", "").replace("http://", "").strip()
    client_id = os.getenv("SHOPIFY_CLIENT_ID")
    client_secret = os.getenv("SHOPIFY_CLIENT_SECRET")
    
    if not client_id or not client_secret or client_id.startswith("x") or client_secret.startswith("shpss_x"):
        print("❌ Error: SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET is missing or using placeholder in environment / .env")
        return None
    
    url = f"https://{shop}/admin/oauth/access_token"
    payload = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret
    }
    
    print(f"🔄 Requesting new access token from https://{shop}...")
    try:
        # OAuth client credentials grant requires body payload
        res = requests.post(url, json=payload, timeout=10)
        if res.status_code != 200:
            res = requests.post(url, data=payload, timeout=10)
            
        if res.status_code != 200:
            print(f"❌ Failed to get token (HTTP {res.status_code}): {res.text[:500]}")
            return None

        try:
            data = res.json()
        except ValueError:
            print(f"❌ Failed to parse JSON response (HTTP {res.status_code}): {res.text[:500]}")
            return None
    except Exception as e:
        print(f"❌ HTTP Request failed: {e}")
        return None
    
    if res.status_code != 200 or "access_token" not in data:
        print(f"❌ Failed to get token (HTTP {res.status_code}): {data}")
        return None
    
    access_token = data["access_token"]
    expires_in = data.get("expires_in", 86400)
    hours = round(expires_in / 3600, 1)
    
    print(f"✅ Token received successfully!")
    print(f"   Token: {access_token}")
    print(f"   Expires in: {expires_in} seconds (~{hours} hours)")
    
    # Update .env file
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        token_keys = [
            "SHOPIFY_ACCESS_TOKEN",
            "SHOPIFY_ACCESS_TOKEN_CATEGORY",
            "SHOPIFY_ACCESS_TOKEN_IMPORT_MENU",
            "SHOPIFY_ACCESS_TOKEN_IMPORT_PRODUCT",
            "SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT",
        ]
        
        for key in token_keys:
            if re.search(rf"^{key}=.*$", content, flags=re.MULTILINE):
                content = re.sub(rf"^{key}=.*$", f"{key}={access_token}", content, flags=re.MULTILINE)
            else:
                content += f"\n{key}={access_token}"
        
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"💾 Updated {env_path} with the new token!")
    else:
        print(f"⚠️  {env_path} file not found.")

    return access_token

if __name__ == "__main__":
    generate_token()
