import blog_utils


class TestNormalizeArticleGid:
    def test_plain_numeric_string(self):
        assert blog_utils.normalize_article_gid("643110502599") == "gid://shopify/Article/643110502599"

    def test_numeric_int(self):
        assert blog_utils.normalize_article_gid(643110502599) == "gid://shopify/Article/643110502599"

    def test_already_a_gid_passes_through_unchanged(self):
        gid = "gid://shopify/Article/643110502599"
        assert blog_utils.normalize_article_gid(gid) == gid

    def test_pandas_float_upcast_artifact(self):
        # Real bug: a CSV "Article ID" column with any blank cell gets upcast
        # to float64 by pandas, turning a valid numeric ID into "X.0".
        assert blog_utils.normalize_article_gid("643110502599.0") == "gid://shopify/Article/643110502599"

    def test_whitespace_is_stripped(self):
        assert blog_utils.normalize_article_gid("  643110502599  ") == "gid://shopify/Article/643110502599"

    def test_non_numeric_garbage_passes_through_unchanged(self):
        # Not our job to validate — an invalid ID should reach Shopify's own
        # error handling, not get silently mangled into something else.
        assert blog_utils.normalize_article_gid("not-an-id") == "not-an-id"


class TestNormalizeBlogGid:
    def test_plain_numeric_string(self):
        assert blog_utils.normalize_blog_gid("99382919367") == "gid://shopify/Blog/99382919367"

    def test_pandas_float_upcast_artifact(self):
        assert blog_utils.normalize_blog_gid("99382919367.0") == "gid://shopify/Blog/99382919367"

    def test_already_a_gid_passes_through_unchanged(self):
        gid = "gid://shopify/Blog/99382919367"
        assert blog_utils.normalize_blog_gid(gid) == gid

    def test_blog_and_article_gids_use_the_right_resource_name(self):
        # Both go through the same _normalize_numeric_gid() helper —
        # guards against a copy-paste mistake swapping "Blog"/"Article".
        assert "/Blog/" in blog_utils.normalize_blog_gid("123")
        assert "/Article/" in blog_utils.normalize_article_gid("123")
