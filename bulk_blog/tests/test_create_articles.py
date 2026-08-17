import pandas as pd

import create_articles
from create_articles import create_article


def row(**kwargs):
    defaults = {
        "Title": "", "Blog GID": "", "Body": "", "Author": "", "Tags": "",
        "Published": "", "Image URL": "", "Image Alt": "", "Theme Template": "",
        "SEO Title": "", "SEO Description": "",
    }
    defaults.update(kwargs)
    return pd.Series(defaults)


class FakeGql:
    """Stand-in for blog_utils.gql — records the call and returns a canned
    response, so create_article() can be tested without hitting Shopify."""

    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, api_url, headers, query, variables=None):
        self.calls.append({"query": query, "variables": variables})
        return self.response

    @property
    def last_article_input(self):
        return self.calls[-1]["variables"]["article"]


def success_response(article_id="gid://shopify/Article/999", title="T"):
    return {
        "data": {
            "articleCreate": {
                "article": {"id": article_id, "title": title, "image": None},
                "userErrors": [],
            }
        }
    }


class TestValidationBeforeCallingShopify:
    def test_no_title_is_skipped_without_calling_gql(self, monkeypatch):
        fake = FakeGql(success_response())
        monkeypatch.setattr(create_articles, "gql", fake)

        result = create_article(row(**{"Blog GID": "123"}))

        assert result["status"] == "skipped"
        assert fake.calls == []

    def test_no_blog_gid_is_error_without_calling_gql(self, monkeypatch):
        fake = FakeGql(success_response())
        monkeypatch.setattr(create_articles, "gql", fake)

        result = create_article(row(Title="Hello"))

        assert result["status"] == "error"
        assert fake.calls == []


class TestArticleInputAssembly:
    def test_minimal_row(self, monkeypatch):
        fake = FakeGql(success_response())
        monkeypatch.setattr(create_articles, "gql", fake)

        create_article(row(Title="Hello", **{"Blog GID": "99382919367"}))

        sent = fake.last_article_input
        assert sent["blogId"] == "gid://shopify/Blog/99382919367"
        assert sent["title"] == "Hello"
        assert sent["isPublished"] is False
        assert "author" not in sent
        assert "tags" not in sent
        assert "templateSuffix" not in sent
        assert "image" not in sent
        assert "metafields" not in sent

    def test_blog_gid_already_a_full_gid_passes_through(self, monkeypatch):
        fake = FakeGql(success_response())
        monkeypatch.setattr(create_articles, "gql", fake)

        create_article(row(Title="Hello", **{"Blog GID": "gid://shopify/Blog/99382919367"}))

        assert fake.last_article_input["blogId"] == "gid://shopify/Blog/99382919367"

    def test_tags_theme_template_and_image(self, monkeypatch):
        fake = FakeGql(success_response())
        monkeypatch.setattr(create_articles, "gql", fake)

        create_article(row(
            Title="Hello", **{
                "Blog GID": "123",
                "Tags": "a, b",
                "Theme Template": "premium",
                "Image URL": "https://x/img.jpg",
                "Image Alt": "alt text",
            }
        ))

        sent = fake.last_article_input
        assert sent["tags"] == ["a", "b"]
        assert sent["templateSuffix"] == "premium"
        assert sent["image"] == {"url": "https://x/img.jpg", "altText": "alt text"}

    def test_seo_fields_become_global_metafields_not_seo_object(self, monkeypatch):
        # Regression test for the "seo" field mistake: Article has no `seo`
        # input field (confirmed via live schema introspection) — SEO must
        # go through metafields (namespace "global", type "string").
        fake = FakeGql(success_response())
        monkeypatch.setattr(create_articles, "gql", fake)

        create_article(row(
            Title="Hello", **{
                "Blog GID": "123",
                "SEO Title": "Page Title",
                "SEO Description": "Meta desc",
            }
        ))

        sent = fake.last_article_input
        assert "seo" not in sent
        assert sent["metafields"] == [
            {"namespace": "global", "key": "title_tag", "value": "Page Title", "type": "string"},
            {"namespace": "global", "key": "description_tag", "value": "Meta desc", "type": "string"},
        ]


class TestResponseHandling:
    def test_success_extracts_article_id(self, monkeypatch):
        fake = FakeGql(success_response(article_id="gid://shopify/Article/42", title="Hello"))
        monkeypatch.setattr(create_articles, "gql", fake)

        result = create_article(row(Title="Hello", **{"Blog GID": "123"}))

        assert result["status"] == "success"
        assert result["article_id"] == "gid://shopify/Article/42"

    def test_user_errors_become_error_status(self, monkeypatch):
        fake = FakeGql({
            "data": {
                "articleCreate": {
                    "article": None,
                    "userErrors": [{"field": ["article"], "message": "Must reference an existing blog."}],
                }
            }
        })
        monkeypatch.setattr(create_articles, "gql", fake)

        result = create_article(row(Title="Hello", **{"Blog GID": "123"}))

        assert result["status"] == "error"
        assert "Must reference an existing blog" in result["message"]

    def test_gql_returning_none_becomes_error(self, monkeypatch):
        monkeypatch.setattr(create_articles, "gql", lambda *a, **k: None)

        result = create_article(row(Title="Hello", **{"Blog GID": "123"}))

        assert result["status"] == "error"
