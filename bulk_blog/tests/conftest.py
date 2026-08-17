"""
conftest.py
-----------
Runs before any test module is collected. Every bulk_blog/*.py script builds
a Shopify client at import time (blog_utils.HEADERS = make_headers(...)),
which raises RuntimeError if no token is available — fine when a real .env
is present locally, fatal in CI where there's no token and no network.

setdefault() only fills this in when a real token isn't already set (e.g.
from a local .env), so local runs still use real credentials if present;
nothing here ever makes a network call — these are unit tests for pure
logic, not integration tests against live Shopify.
"""

import os
import sys

os.environ.setdefault("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT", "test_dummy_token_do_not_use")

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
BULK_BLOG_DIR = os.path.dirname(TESTS_DIR)
if BULK_BLOG_DIR not in sys.path:
    sys.path.insert(0, BULK_BLOG_DIR)
