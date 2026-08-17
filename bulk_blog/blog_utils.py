"""
blog_utils.py
--------------
Shared Shopify plumbing for the bulk_blog/*.py scripts: GID normalization,
existing-article/blog lookups, and Thai translation registration.

Pulled out of create_articles.py / update_articles.py / delete_articles.py /
list_articles.py / validate_csv.py, which each carried a near-identical copy
of this code — a fix applied to one copy (e.g. the float-string GID bug
below) was easy to forget in the others.

Import this from a script living directly in bulk_blog/ (plain `import
blog_utils` works because Python puts the running script's own directory on
sys.path[0]).
"""

import os
import importlib.util

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
UTILS_PATH = os.path.join(ROOT_DIR, "bulk_product", "utils.py")

_spec = importlib.util.spec_from_file_location("shopify_utils", UTILS_PATH)
_shopify_utils = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_shopify_utils)

make_headers = _shopify_utils.make_headers
gql = _shopify_utils.gql
API_URL = _shopify_utils.API_URL
read_csv_auto = _shopify_utils.read_csv_auto
get_val = _shopify_utils.get_val

HEADERS = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")

LOCALE_TH = "th"


# ── GID normalization ──────────────────────────────────────────────────────

def _normalize_numeric_gid(value, resource: str) -> str:
    """Turns '123', 123, or '123.0' into a full GID for the given resource.
    Leaves an already-fully-qualified GID untouched.

    The '.0' case matters: if a CSV's ID column has any blank/NaN cell,
    pandas upcasts the whole column to float64, so a valid numeric ID like
    643110502599 arrives here as the string '643110502599.0' — without this
    strip, .isdigit() is False and the ID is sent to Shopify unconverted.
    """
    value = str(value).strip()
    if value.endswith(".0") and value[:-2].isdigit():
        value = value[:-2]
    if value.isdigit():
        return f"gid://shopify/{resource}/{value}"
    return value


def normalize_blog_gid(value: str) -> str:
    return _normalize_numeric_gid(value, "Blog")


def normalize_article_gid(value: str) -> str:
    return _normalize_numeric_gid(value, "Article")


# ── Blog / article lookups ─────────────────────────────────────────────────

BLOGS_QUERY = "{ blogs(first: 50) { edges { node { id title } } } }"


def fetch_known_blogs() -> dict:
    """Returns {blog_gid: title} for every blog in the shop."""
    res = gql(API_URL, HEADERS, BLOGS_QUERY)
    if not res:
        return {}
    return {e["node"]["id"]: e["node"]["title"] for e in res["data"]["blogs"]["edges"]}


ARTICLES_QUERY = """
query BlogArticles($id: ID!, $cursor: String) {
  blog(id: $id) {
    title
    articles(first: 250, after: $cursor) {
      edges { node { id title isPublished createdAt } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"""


def fetch_blog_articles(blog_gid: str):
    """Returns (blog_title, [article_node, ...]) with pagination handled.
    Each node has id, title, isPublished, createdAt."""
    articles = []
    cursor = None
    blog_title = None

    while True:
        res = gql(API_URL, HEADERS, ARTICLES_QUERY, {"id": blog_gid, "cursor": cursor})
        if not res or not res.get("data") or not res["data"].get("blog"):
            print(f"[WARN] Could not fetch articles for blog {blog_gid}")
            break

        blog = res["data"]["blog"]
        blog_title = blog["title"]
        conn = blog["articles"]
        articles.extend(edge["node"] for edge in conn["edges"])

        if conn["pageInfo"]["hasNextPage"]:
            cursor = conn["pageInfo"]["endCursor"]
        else:
            break

    return blog_title, articles


def fetch_existing_titles(blog_gid: str) -> dict:
    """Returns {title: article_id} — convenience wrapper for duplicate checks."""
    _, articles = fetch_blog_articles(blog_gid)
    return {a["title"]: a["id"] for a in articles}


# ── Thai translation ────────────────────────────────────────────────────────

ARTICLE_GET_DIGESTS = """
query GetArticleDigests($id: ID!) {
  translatableResource(resourceId: $id) {
    translatableContent { key digest }
  }
}
"""

ARTICLE_REGISTER_TRANSLATION = """
mutation RegisterTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { key locale }
    userErrors { field message }
  }
}
"""


def register_thai_translation(article_id: str, title_th: str, body_th: str) -> dict:
    """ลงทะเบียน translation ภาษาไทยสำหรับ article ที่มีอยู่แล้ว"""
    res_digest = gql(API_URL, HEADERS, ARTICLE_GET_DIGESTS, {"id": article_id})
    if not res_digest:
        return {"status": "error", "message": "Could not fetch article digests"}

    content_list = (
        res_digest.get("data", {})
        .get("translatableResource", {})
        .get("translatableContent", [])
    )
    digest_map = {item["key"]: item["digest"] for item in content_list}

    translations = []
    if title_th and "title" in digest_map:
        translations.append({
            "key": "title", "value": title_th, "locale": LOCALE_TH,
            "translatableContentDigest": digest_map["title"]
        })
    if body_th and "body_html" in digest_map:
        translations.append({
            "key": "body_html", "value": body_th, "locale": LOCALE_TH,
            "translatableContentDigest": digest_map["body_html"]
        })

    if not translations:
        return {"status": "skipped", "message": "No TH content or digest not found"}

    res_reg = gql(API_URL, HEADERS, ARTICLE_REGISTER_TRANSLATION, {
        "resourceId": article_id,
        "translations": translations
    })
    if not res_reg:
        return {"status": "error", "message": "GraphQL request failed (translation)"}

    reg_data = res_reg.get("data", {}).get("translationsRegister", {})
    reg_errors = reg_data.get("userErrors", [])
    if reg_errors:
        return {"status": "error", "message": "; ".join(f"{e.get('field')}: {e.get('message')}" for e in reg_errors)}

    keys_registered = [t["key"] for t in reg_data.get("translations", [])]
    return {"status": "success", "message": f"Registered TH keys: {keys_registered}"}
