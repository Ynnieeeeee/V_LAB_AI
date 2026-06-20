import unittest

from app.utils.public_urls import normalize_browser_asset_url


class NormalizeBrowserAssetUrlTests(unittest.TestCase):
    def test_rewrites_loopback_hosts(self):
        self.assertEqual(
            normalize_browser_asset_url("http://localhost:8000/static/models/beaker.glb"),
            "/static/models/beaker.glb",
        )
        self.assertEqual(
            normalize_browser_asset_url("https://127.0.0.1:8000/assets/model.glb?v=2"),
            "/assets/model.glb?v=2",
        )

    def test_preserves_public_and_relative_urls(self):
        public_url = "https://cdn.example.com/models/beaker.glb"
        relative_url = "/static/models/beaker.glb"
        self.assertEqual(normalize_browser_asset_url(public_url), public_url)
        self.assertEqual(normalize_browser_asset_url(relative_url), relative_url)


if __name__ == "__main__":
    unittest.main()
