import unittest
from unittest.mock import patch

try:
    from app.services import mesh_service
except ModuleNotFoundError as exc:
    mesh_service = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


@unittest.skipIf(mesh_service is None, f"project dependency is not installed: {getattr(IMPORT_ERROR, 'name', IMPORT_ERROR)}")
class MeshServiceTripoV3Tests(unittest.TestCase):
    def setUp(self):
        self.original_api_key = mesh_service.TRIPO_API_KEY
        self.original_base_url = mesh_service.TRIPO_API_BASE_URL
        self.original_model_version = mesh_service.TRIPO_MODEL_VERSION
        self.original_texture_quality = mesh_service.TRIPO_TEXTURE_QUALITY
        self.original_input_mode = mesh_service.TRIPO_IMAGE_INPUT_MODE
        self.original_face_limit = mesh_service.TRIPO_FACE_LIMIT
        mesh_service.TRIPO_API_KEY = "test-token"
        mesh_service.TRIPO_API_BASE_URL = "https://openapi.tripo3d.ai/v3"
        mesh_service.TRIPO_MODEL_VERSION = "v3.1-20260211"
        mesh_service.TRIPO_TEXTURE_QUALITY = "detailed"
        mesh_service.TRIPO_IMAGE_INPUT_MODE = "upload"
        mesh_service.TRIPO_FACE_LIMIT = 0

    def tearDown(self):
        mesh_service.TRIPO_API_KEY = self.original_api_key
        mesh_service.TRIPO_API_BASE_URL = self.original_base_url
        mesh_service.TRIPO_MODEL_VERSION = self.original_model_version
        mesh_service.TRIPO_TEXTURE_QUALITY = self.original_texture_quality
        mesh_service.TRIPO_IMAGE_INPUT_MODE = self.original_input_mode
        mesh_service.TRIPO_FACE_LIMIT = self.original_face_limit

    def test_create_3d_task_uses_tripo_v3_generation_payload(self):
        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None, **kwargs):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            captured["timeout"] = timeout
            return _FakeResponse({"code": 0, "data": {"task_id": "task_abc123"}})

        service = mesh_service.MeshService()
        service.upload_image_and_get_file_token = lambda *args, **kwargs: "file_abc123"

        with patch.object(mesh_service, "clean_tool_image_for_3d", return_value="https://example.com/tool.png"):
            with patch.object(mesh_service.requests, "post", side_effect=fake_post):
                task_id = service.create_3d_task(
                    "https://example.com/tool.png",
                    tool_name_en="beaker",
                    name_vi="coc thuy tinh",
                    tool_type="container",
                )

        self.assertEqual(task_id, "task_abc123")
        self.assertEqual(captured["url"], "https://openapi.tripo3d.ai/v3/generation/image-to-model")
        self.assertEqual(captured["json"]["input"], "file_abc123")
        self.assertEqual(captured["json"]["model"], "v3.1-20260211")
        self.assertTrue(captured["json"]["texture"])
        self.assertTrue(captured["json"]["pbr"])
        self.assertEqual(captured["json"]["texture_quality"], "detailed")
        self.assertNotIn("type", captured["json"])
        self.assertNotIn("model_version", captured["json"])
        self.assertNotIn("file", captured["json"])

    def test_check_task_status_reads_v3_output_model_url(self):
        captured = {}

        def fake_get(url, headers=None, timeout=None, **kwargs):
            captured["url"] = url
            return _FakeResponse({
                "code": 0,
                "data": {
                    "task_id": "task_abc123",
                    "status": "success",
                    "progress": 100,
                    "output": {
                        "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
                    },
                },
            })

        service = mesh_service.MeshService()
        with patch.object(mesh_service.requests, "get", side_effect=fake_get):
            result = service.check_task_status("task_abc123")

        self.assertEqual(captured["url"], "https://openapi.tripo3d.ai/v3/tasks/task_abc123")
        self.assertEqual(result, "https://cdn.tripo3d.ai/output/model_pbr.glb")


if __name__ == "__main__":
    unittest.main()
