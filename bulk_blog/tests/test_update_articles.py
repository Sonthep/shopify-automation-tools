import pandas as pd

from update_articles import build_update_input


def row(**kwargs):
    """Build a pd.Series like a CSV row would produce (blank cells as "")."""
    defaults = {
        "Title": "", "Body": "", "Author": "", "Tags": "", "Published": "",
        "Image URL": "", "Image Alt": "", "Theme Template": "",
        "SEO Title": "", "SEO Description": "",
    }
    defaults.update(kwargs)
    return pd.Series(defaults)


class TestBlankRow:
    def test_all_blank_produces_empty_input(self):
        # Caller (main()) is responsible for skipping an empty dict —
        # build_update_input() itself should never invent a field.
        assert build_update_input(row()) == {}


class TestSimpleFields:
    def test_title_and_body(self):
        result = build_update_input(row(Title="New Title", Body="<p>New body</p>"))
        assert result == {"title": "New Title", "body": "<p>New body</p>"}

    def test_author(self):
        result = build_update_input(row(Author="Sevenfive"))
        assert result == {"author": {"name": "Sevenfive"}}

    def test_theme_template(self):
        result = build_update_input(row(**{"Theme Template": "premium"}))
        assert result == {"templateSuffix": "premium"}

    def test_image_with_alt(self):
        result = build_update_input(row(**{"Image URL": "https://x/img.jpg", "Image Alt": "desc"}))
        assert result == {"image": {"url": "https://x/img.jpg", "altText": "desc"}}

    def test_image_without_alt(self):
        result = build_update_input(row(**{"Image URL": "https://x/img.jpg"}))
        assert result == {"image": {"url": "https://x/img.jpg"}}


class TestPublished:
    def test_blank_leaves_published_untouched(self):
        assert "isPublished" not in build_update_input(row(Published=""))

    def test_true_values(self):
        for v in ("true", "TRUE", "1", "yes", "y"):
            assert build_update_input(row(Published=v))["isPublished"] is True

    def test_false_values(self):
        for v in ("false", "0", "no", "n", "garbage"):
            assert build_update_input(row(Published=v))["isPublished"] is False


class TestTags:
    def test_normal_comma_separated_list(self):
        result = build_update_input(row(Tags="a, b,c"))
        assert result["tags"] == ["a", "b", "c"]

    def test_blank_cell_leaves_tags_untouched(self):
        assert "tags" not in build_update_input(row(Tags=""))

    def test_malformed_cell_does_not_wipe_existing_tags(self):
        # Regression test: ",," used to parse to [] and get sent as
        # tags: [] to Shopify, silently deleting every existing tag.
        result = build_update_input(row(Tags=",,"))
        assert "tags" not in result

    def test_malformed_cell_of_only_whitespace_does_not_wipe_tags(self):
        result = build_update_input(row(Tags="  ,  ,  "))
        assert "tags" not in result


class TestSeoMetafields:
    """Regression tests: Article has no `seo` field on ArticleUpdateInput —
    confirmed via live schema introspection. The real mechanism is legacy
    metafields (namespace "global", keys title_tag/description_tag, type
    "string"), also confirmed against a live article that already had them
    set from the Shopify admin UI."""

    def test_seo_title_only(self):
        result = build_update_input(row(**{"SEO Title": "My Title"}))
        assert result["metafields"] == [
            {"namespace": "global", "key": "title_tag", "value": "My Title", "type": "string"}
        ]
        assert "seo" not in result

    def test_seo_description_only(self):
        result = build_update_input(row(**{"SEO Description": "My description"}))
        assert result["metafields"] == [
            {"namespace": "global", "key": "description_tag", "value": "My description", "type": "string"}
        ]

    def test_seo_title_and_description_together(self):
        result = build_update_input(row(**{"SEO Title": "T", "SEO Description": "D"}))
        assert result["metafields"] == [
            {"namespace": "global", "key": "title_tag", "value": "T", "type": "string"},
            {"namespace": "global", "key": "description_tag", "value": "D", "type": "string"},
        ]

    def test_blank_seo_fields_omit_metafields_key(self):
        assert "metafields" not in build_update_input(row())


class TestCombinedFields:
    def test_multiple_fields_at_once(self):
        result = build_update_input(row(
            Title="T", Tags="x,y", Published="true", **{"Theme Template": "premium"}
        ))
        assert result == {
            "title": "T",
            "tags": ["x", "y"],
            "isPublished": True,
            "templateSuffix": "premium",
        }
