import pandas as pd

import delete_articles
from delete_articles import delete_article, gather_ids_from_csv
from blog_utils import normalize_article_gid


class FakeGql:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, api_url, headers, query, variables=None):
        self.calls.append(variables)
        return self.response


class TestDeleteArticle:
    def test_success(self, monkeypatch):
        fake = FakeGql({"data": {"articleDelete": {"deletedArticleId": "gid://shopify/Article/1", "userErrors": []}}})
        monkeypatch.setattr(delete_articles, "gql", fake)

        result = delete_article("gid://shopify/Article/1")

        assert result["status"] == "success"
        assert fake.calls == [{"id": "gid://shopify/Article/1"}]

    def test_user_errors(self, monkeypatch):
        fake = FakeGql({"data": {"articleDelete": {"deletedArticleId": None, "userErrors": [{"field": "id", "message": "not found"}]}}})
        monkeypatch.setattr(delete_articles, "gql", fake)

        result = delete_article("gid://shopify/Article/999")

        assert result["status"] == "error"
        assert "not found" in result["message"]

    def test_gql_returning_none(self, monkeypatch):
        monkeypatch.setattr(delete_articles, "gql", lambda *a, **k: None)

        result = delete_article("gid://shopify/Article/1")

        assert result["status"] == "error"

    def test_missing_deleted_id_is_an_error_not_a_silent_success(self, monkeypatch):
        fake = FakeGql({"data": {"articleDelete": {"deletedArticleId": None, "userErrors": []}}})
        monkeypatch.setattr(delete_articles, "gql", fake)

        result = delete_article("gid://shopify/Article/1")

        assert result["status"] == "error"


class TestGatherIdsFromCsv:
    def test_reads_article_id_column(self, tmp_path):
        csv_path = tmp_path / "ids.csv"
        csv_path.write_text("Article ID,Title\n123,Foo\n456,Bar\n", encoding="utf-8")

        assert gather_ids_from_csv(str(csv_path)) == ["123", "456"]

    def test_skips_blank_id_rows(self, tmp_path):
        csv_path = tmp_path / "ids.csv"
        csv_path.write_text("Article ID,Title\n123,Foo\n,Bar\n456,Baz\n", encoding="utf-8")

        # A blank cell in this column makes pandas upcast the whole column to
        # float64, so the surviving IDs come back as "123.0"/"456.0" here —
        # that's the raw read, not yet normalized (see the float-upcast test
        # below for where that actually gets fixed).
        assert gather_ids_from_csv(str(csv_path)) == ["123.0", "456.0"]

    def test_blank_row_causes_pandas_float_upcast_but_normalize_still_fixes_it(self, tmp_path):
        # This is the exact real-world CSV shape that caused the original bug:
        # a blank cell anywhere in "Article ID" makes pandas read the whole
        # column as float64, so "643110502599" arrives as "643110502599.0".
        csv_path = tmp_path / "ids.csv"
        csv_path.write_text("Article ID,Title\n643110502599,Foo\n,Bar\n", encoding="utf-8")

        raw_ids = gather_ids_from_csv(str(csv_path))
        assert raw_ids == ["643110502599.0"]  # the float-upcast artifact, as read

        normalized = [normalize_article_gid(i) for i in raw_ids]
        assert normalized == ["gid://shopify/Article/643110502599"]  # fixed by normalize_article_gid
