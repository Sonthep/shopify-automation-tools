import validate_csv
from validate_csv import extract_body_image_urls, VALID_PUBLISHED_VALUES, url_is_reachable


class TestExtractBodyImageUrls:
    def test_blank_returns_empty(self):
        assert extract_body_image_urls("") == []

    def test_none_returns_empty(self):
        assert extract_body_image_urls(None) == []

    def test_no_img_tags_returns_empty(self):
        assert extract_body_image_urls("<p>just text</p>") == []

    def test_single_img_tag(self):
        html = '<p>text</p><img src="https://x/a.jpg" alt="a">'
        assert extract_body_image_urls(html) == ["https://x/a.jpg"]

    def test_multiple_img_tags(self):
        html = '<img src="https://x/a.jpg"><p>mid</p><img src="https://x/b.jpg">'
        assert extract_body_image_urls(html) == ["https://x/a.jpg", "https://x/b.jpg"]

    def test_duplicate_urls_are_deduped_preserving_order(self):
        html = '<img src="https://x/a.jpg"><img src="https://x/b.jpg"><img src="https://x/a.jpg">'
        assert extract_body_image_urls(html) == ["https://x/a.jpg", "https://x/b.jpg"]

    def test_single_quoted_src_attribute(self):
        html = "<img src='https://x/a.jpg'>"
        assert extract_body_image_urls(html) == ["https://x/a.jpg"]


class TestValidPublishedValues:
    def test_recognized_true_ish_values(self):
        for v in ("true", "1", "yes", "y"):
            assert v in VALID_PUBLISHED_VALUES

    def test_recognized_false_ish_values(self):
        for v in ("false", "0", "no", "n", ""):
            assert v in VALID_PUBLISHED_VALUES

    def test_garbage_value_not_recognized(self):
        assert "maybe" not in VALID_PUBLISHED_VALUES


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code

    def close(self):
        pass


class TestUrlIsReachable:
    def test_ok_status_is_reachable(self, monkeypatch):
        monkeypatch.setattr(validate_csv.requests, "head", lambda *a, **k: FakeResponse(200))

        ok, detail = url_is_reachable("https://x/a.jpg")

        assert ok is True

    def test_404_is_not_reachable(self, monkeypatch):
        monkeypatch.setattr(validate_csv.requests, "head", lambda *a, **k: FakeResponse(404))

        ok, detail = url_is_reachable("https://x/a.jpg")

        assert ok is False
        assert "404" in detail

    def test_405_falls_back_to_get(self, monkeypatch):
        # Regression case: some hosts (e.g. chatgpt.com backend URLs) reject
        # HEAD but work fine with GET.
        monkeypatch.setattr(validate_csv.requests, "head", lambda *a, **k: FakeResponse(405))
        monkeypatch.setattr(validate_csv.requests, "get", lambda *a, **k: FakeResponse(200))

        ok, detail = url_is_reachable("https://x/a.jpg")

        assert ok is True
        assert "GET" in detail

    def test_connection_error_is_not_reachable(self, monkeypatch):
        def raise_error(*a, **k):
            raise ConnectionError("boom")

        monkeypatch.setattr(validate_csv.requests, "head", raise_error)

        ok, detail = url_is_reachable("https://x/a.jpg")

        assert ok is False
        assert "boom" in detail
