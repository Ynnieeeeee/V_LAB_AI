import logging
import re
import unicodedata

from sqlalchemy import text


logger = logging.getLogger(__name__)


HEATING_SOURCE_KEYWORDS = (
    "den con",
    "bep",
    "bep dien",
    "bep gia nhiet",
    "bep dun",
    "den dot",
    "den bunsen",
    "mo dot",
    "nguon nhiet",
    "alcohol lamp",
    "burner",
    "bunsen burner",
    "hot plate",
    "heater",
    "heating plate",
)

CONTAINER_KEYWORDS = (
    "ong nghiem",
    "coc thuy tinh",
    "coc",
    "binh tam giac",
    "binh cau",
    "binh",
    "dung cu chua",
    "vat chua",
    "container",
    "vessel",
    "beaker",
    "test tube",
    "flask",
    "erlenmeyer",
    "tube",
    "jar",
    "cup",
)


def normalize_text(value: str = "") -> str:
    normalized = unicodedata.normalize("NFD", value or "")
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    without_marks = without_marks.replace("đ", "d").replace("Đ", "d")
    return re.sub(r"\s+", " ", without_marks.lower()).strip()


def _contains_keyword(text_value: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text_value for keyword in keywords)


def is_heating_source_name(text_value: str) -> bool:
    return _contains_keyword(text_value, HEATING_SOURCE_KEYWORDS)


def is_container_name(text_value: str) -> bool:
    return _contains_keyword(text_value, CONTAINER_KEYWORDS)


def classify_tool_by_name(name_vi: str = "", name_en: str = "") -> dict:
    text_value = normalize_text(f"{name_vi} {name_en}")

    if is_heating_source_name(text_value):
        return {
            "tool_type": "heating_source",
            "is_heating_source": True,
            "heating_power": 8,
            "max_temperature": 120,
            "is_toggleable": True,
        }

    if is_container_name(text_value):
        return {
            "tool_type": "container",
            "is_heating_source": False,
            "heating_power": 0,
            "max_temperature": 25,
            "is_toggleable": False,
        }

    logger.warning("[ToolClassifier] Unknown tool type: %s %s", name_vi, name_en)
    return {
        "tool_type": "unknown",
        "is_heating_source": False,
        "heating_power": 0,
        "max_temperature": 25,
        "is_toggleable": False,
    }


def ensure_tools_metadata_columns(session) -> None:
    bind = session.get_bind()
    table_name = "public.tools" if bind and bind.dialect.name == "postgresql" else "tools"
    statements = [
        f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS tool_type text DEFAULT 'unknown'",
        f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS is_heating_source boolean DEFAULT false",
        f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS heating_power double precision DEFAULT 0",
        f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS max_temperature double precision DEFAULT 25",
        f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS is_toggleable boolean DEFAULT false",
    ]
    for statement in statements:
        session.exec(text(statement))

    session.exec(text(f"""
        UPDATE {table_name}
        SET
            tool_type = 'heating_source',
            is_heating_source = true,
            heating_power = 8,
            max_temperature = 120,
            is_toggleable = true
        WHERE (tool_type IS NULL OR tool_type = 'unknown')
          AND (
            lower(name_tool_vi) LIKE '%đèn cồn%'
            OR lower(name_tool_vi) LIKE '%den con%'
            OR lower(name_tool_vi) LIKE '%bếp%'
            OR lower(name_tool_vi) LIKE '%bep%'
            OR lower(name_tool_vi) LIKE '%nguồn nhiệt%'
            OR lower(name_tool_vi) LIKE '%nguon nhiet%'
            OR lower(name_tool_en) LIKE '%alcohol lamp%'
            OR lower(name_tool_en) LIKE '%burner%'
            OR lower(name_tool_en) LIKE '%hot plate%'
            OR lower(name_tool_en) LIKE '%heater%'
            OR lower(name_tool_en) LIKE '%heating plate%'
          )
    """))
    session.exec(text(f"""
        UPDATE {table_name}
        SET
            tool_type = 'container',
            is_heating_source = false,
            heating_power = 0,
            max_temperature = 25,
            is_toggleable = false
        WHERE (tool_type IS NULL OR tool_type = 'unknown')
          AND (
            lower(name_tool_vi) LIKE '%ống nghiệm%'
            OR lower(name_tool_vi) LIKE '%ong nghiem%'
            OR lower(name_tool_vi) LIKE '%cốc%'
            OR lower(name_tool_vi) LIKE '%coc%'
            OR lower(name_tool_vi) LIKE '%bình%'
            OR lower(name_tool_vi) LIKE '%binh%'
            OR lower(name_tool_en) LIKE '%test tube%'
            OR lower(name_tool_en) LIKE '%beaker%'
            OR lower(name_tool_en) LIKE '%flask%'
            OR lower(name_tool_en) LIKE '%container%'
            OR lower(name_tool_en) LIKE '%vessel%'
          )
    """))
