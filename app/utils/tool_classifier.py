import logging
import json
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

SUPPORT_STAND_KEYWORDS = (
    "gia do",
    "gia thi nghiem",
    "kieng ba chan",
    "chan de",
    "tripod stand",
    "lab stand",
    "support stand",
    "ring stand",
)

DROPPING_FUNNEL_KEYWORDS = (
    "pheu nho giot",
    "phieu nho giot",
    "dropping funnel",
    "addition funnel",
)

GAS_TUBE_KEYWORDS = (
    "ong dan khi",
    "ong thuy tinh dan khi",
    "ong cao su dan khi",
    "gas tube",
    "delivery tube",
    "rubber tubing",
    "glass tubing",
)

GAS_COLLECTOR_KEYWORDS = (
    "binh thu khi",
    "chau thu khi",
    "ong thu khi",
    "gas jar",
    "gas collector",
    "collection bottle",
)

STIRRING_TOOL_KEYWORDS = (
    "dua thuy tinh",
    "que khuay",
    "glass rod",
    "stirring rod",
    "stirrer",
)

MEASURING_TOOL_KEYWORDS = (
    "ong dong",
    "ong do",
    "ong chia vach",
    "pipet",
    "pipette",
    "measuring cylinder",
    "graduated cylinder",
    "buret",
    "burette",
)

FUNNEL_KEYWORDS = (
    "pheu loc",
    "pheu",
    "filter funnel",
    "funnel",
)

CLAMP_TOOL_KEYWORDS = (
    "kep",
    "kep ong nghiem",
    "kep go",
    "clamp",
    "utility clamp",
    "test tube clamp",
    "bosshead",
)


def normalize_text(value: str = "") -> str:
    normalized = unicodedata.normalize("NFD", value or "")
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    without_marks = without_marks.replace("đ", "d").replace("Đ", "d")
    without_marks = without_marks.replace("đ", "d").replace("Đ", "d")
    without_marks = without_marks.replace("đ", "d").replace("Đ", "d")
    return re.sub(r"\s+", " ", without_marks.lower()).strip()


def _contains_keyword(text_value: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text_value for keyword in keywords)


def is_heating_source_name(text_value: str) -> bool:
    return _contains_keyword(text_value, HEATING_SOURCE_KEYWORDS)


def is_container_name(text_value: str) -> bool:
    return _contains_keyword(text_value, CONTAINER_KEYWORDS)


def is_support_stand_name(text_value: str) -> bool:
    return _contains_keyword(text_value, SUPPORT_STAND_KEYWORDS)


def _base_meta(tool_type: str, capabilities=None, ports=None, attach_points=None, assembly_role: str = "none") -> dict:
    return {
        "tool_type": tool_type,
        "is_heating_source": False,
        "heating_power": 0,
        "max_temperature": 25,
        "is_toggleable": False,
        "is_support_stand": False,
        "can_support_tools": False,
        "support_height": 0.8,
        "support_radius": 1.0,
        "capabilities": capabilities or [],
        "ports": ports or {},
        "attach_points": attach_points or {},
        "assembly_role": assembly_role,
    }


def _container_meta() -> dict:
    meta = _base_meta(
        "container",
        capabilities=["contain_liquid", "contain_solid", "receive_liquid", "react", "heat_target"],
        ports={
            "opening": {"type": "opening", "offset": [0, 1, 0]},
            "gas_out": {"type": "gas_out", "offset": [0.3, 1, 0]},
        },
        attach_points={
            "bottom": {"type": "support_target", "offset": [0, -0.5, 0]},
            "clamp_target": {"type": "clamp_target", "offset": [0, 0.45, 0]},
            "heat_target": {"type": "heat_target", "offset": [0, -0.45, 0]},
        },
        assembly_role="reaction_vessel",
    )
    return meta


def _support_meta() -> dict:
    meta = _base_meta(
        "support_stand",
        capabilities=["support", "clamp", "heat_target"],
        attach_points={
            "support_top": {"type": "support_top", "offset": [0, 0.8, 0]},
            "clamp_point": {"type": "clamp_point", "offset": [0.3, 1.2, 0]},
            "heat_target": {"type": "heat_target", "offset": [0, -0.35, 0]},
        },
        assembly_role="support",
    )
    meta.update({
        "is_support_stand": True,
        "can_support_tools": True,
        "support_height": 0.8,
        "support_radius": 1.0,
    })
    return meta


def _heating_source_meta() -> dict:
    meta = _base_meta(
        "heating_source",
        capabilities=["heat"],
        attach_points={
            "heating_zone": {"type": "heating_zone", "offset": [0, 0.3, 0]},
        },
        assembly_role="heating_source",
    )
    meta.update({
        "is_heating_source": True,
        "heating_power": 8,
        "max_temperature": 120,
        "is_toggleable": True,
    })
    return meta


def _dropping_funnel_meta() -> dict:
    return _base_meta(
        "dropping_funnel",
        capabilities=["contain_liquid", "drop_liquid"],
        ports={
            "opening": {"type": "liquid_in", "offset": [0, 0.5, 0]},
            "liquid_out": {"type": "liquid_out", "offset": [0, -0.5, 0]},
        },
        attach_points={"clamp_target": {"type": "clamp_target", "offset": [0, 0.2, 0]}},
        assembly_role="liquid_feeder",
    )


def _gas_tube_meta() -> dict:
    return _base_meta(
        "gas_tube",
        capabilities=["transfer_gas"],
        ports={
            "gas_in": {"type": "gas_in", "offset": [-0.5, 0, 0]},
            "gas_out": {"type": "gas_out", "offset": [0.5, 0, 0]},
        },
        assembly_role="gas_transfer",
    )


def _gas_collector_meta() -> dict:
    return _base_meta(
        "gas_collector",
        capabilities=["collect_gas", "contain_gas"],
        ports={"gas_in": {"type": "gas_in", "offset": [0, 0.8, 0]}},
        assembly_role="gas_collector",
    )


def _stirring_meta() -> dict:
    return _base_meta("stirring_tool", capabilities=["stir"], assembly_role="stirrer")


def _measuring_meta() -> dict:
    return _base_meta(
        "measuring_tool",
        capabilities=["measure_volume", "contain_liquid", "drop_liquid"],
        ports={"liquid_out": {"type": "liquid_out", "offset": [0, -0.5, 0]}},
        assembly_role="measuring",
    )


def _funnel_meta() -> dict:
    return _base_meta(
        "funnel",
        capabilities=["receive_liquid", "transfer_liquid", "filter"],
        ports={
            "opening": {"type": "liquid_in", "offset": [0, 0.4, 0]},
            "liquid_out": {"type": "liquid_out", "offset": [0, -0.45, 0]},
        },
        assembly_role="liquid_transfer",
    )


def _clamp_tool_meta() -> dict:
    return _base_meta(
        "clamp_tool",
        capabilities=["clamp"],
        attach_points={
            "clamp_point": {"type": "clamp_point", "offset": [0, 0.15, 0]},
        },
        assembly_role="clamp",
    )


def classify_tool_by_name(name_vi: str = "", name_en: str = "") -> dict:
    text_value = normalize_text(f"{name_vi} {name_en}")

    if _contains_keyword(text_value, DROPPING_FUNNEL_KEYWORDS):
        return _dropping_funnel_meta()

    if _contains_keyword(text_value, GAS_TUBE_KEYWORDS):
        return _gas_tube_meta()

    if _contains_keyword(text_value, GAS_COLLECTOR_KEYWORDS):
        return _gas_collector_meta()

    if is_support_stand_name(text_value):
        return _support_meta()

    if is_heating_source_name(text_value):
        return _heating_source_meta()

    if _contains_keyword(text_value, STIRRING_TOOL_KEYWORDS):
        return _stirring_meta()

    if _contains_keyword(text_value, MEASURING_TOOL_KEYWORDS):
        return _measuring_meta()

    if _contains_keyword(text_value, CLAMP_TOOL_KEYWORDS):
        return _clamp_tool_meta()

    if _contains_keyword(text_value, FUNNEL_KEYWORDS):
        return _funnel_meta()

    if is_container_name(text_value):
        return _container_meta()

    logger.warning("[ToolClassifier] Unknown tool type: %s %s", name_vi, name_en)
    return _base_meta("unknown")


def _sqlite_columns(session, table_name: str) -> set[str]:
    rows = session.exec(text(f"PRAGMA table_info({table_name})")).all()
    return {row[1] for row in rows}


def _postgres_columns(session) -> set[str]:
    rows = session.exec(text("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tools'
    """)).all()
    columns = set()
    for row in rows:
        try:
            columns.add(str(row[0]))
        except Exception:
            columns.add(str(row))
    return columns


def _safe_exec(session, statement: str) -> None:
    try:
        session.exec(text(statement))
    except Exception as exc:
        logger.warning("[ToolClassifier] schema update skipped/failed: %s | %s", statement, exc)
        try:
            session.rollback()
        except Exception:
            pass


def ensure_tools_metadata_columns(session, backfill_existing: bool = False) -> None:
    bind = session.get_bind()
    dialect = bind.dialect.name if bind else ""
    table_name = "public.tools" if dialect == "postgresql" else "tools"

    columns = {
        "tool_type": ("text", "'unknown'"),
        "is_heating_source": ("boolean", "false"),
        "heating_power": ("double precision", "0"),
        "max_temperature": ("double precision", "25"),
        "is_toggleable": ("boolean", "false"),
        "is_support_stand": ("boolean", "false"),
        "can_support_tools": ("boolean", "false"),
        "support_height": ("double precision", "0.8"),
        "support_radius": ("double precision", "1.0"),
        "scale_x": ("double precision", "1"),
        "scale_y": ("double precision", "1"),
        "scale_z": ("double precision", "1"),
        "has_custom_scale": ("boolean", "false"),
        "capabilities": ("jsonb", "'[]'::jsonb"),
        "ports": ("jsonb", "'{}'::jsonb"),
        "attach_points": ("jsonb", "'{}'::jsonb"),
        "assembly_role": ("text", "'none'"),
    }

    if dialect == "sqlite":
        existing = _sqlite_columns(session, "tools")
        sqlite_type_map = {
            "text": "TEXT",
            "boolean": "BOOLEAN",
            "double precision": "REAL",
            "jsonb": "TEXT",
        }
        for column, (column_type, default_value) in columns.items():
            if column in existing:
                continue
            sqlite_default = "'[]'" if default_value == "'[]'::jsonb" else ("'{}'" if default_value == "'{}'::jsonb" else default_value)
            session.exec(text(
                f"ALTER TABLE tools ADD COLUMN {column} {sqlite_type_map[column_type]} DEFAULT {sqlite_default}"
            ))
    elif dialect == "postgresql":
        existing = _postgres_columns(session)
        for column, (column_type, default_value) in columns.items():
            if column in existing:
                continue
            _safe_exec(
                session,
                f"ALTER TABLE {table_name} ADD COLUMN {column} {column_type} DEFAULT {default_value}",
            )
    else:
        for column, (column_type, default_value) in columns.items():
            generic_type = "json" if column_type == "jsonb" else column_type
            generic_default = "'[]'" if default_value == "'[]'::jsonb" else ("'{}'" if default_value == "'{}'::jsonb" else default_value)
            _safe_exec(
                session,
                f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS {column} {generic_type} DEFAULT {generic_default}",
            )

    if not backfill_existing:
        return

    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'support_stand',
            is_heating_source = false,
            heating_power = 0,
            max_temperature = 25,
            is_toggleable = false,
            is_support_stand = true,
            can_support_tools = true,
            support_height = 0.8,
            support_radius = 1.0,
            capabilities = '["support","clamp","heat_target"]'::jsonb,
            attach_points = '{"support_top":{"type":"support_top","offset":[0,0.8,0]},"clamp_point":{"type":"clamp_point","offset":[0.3,1.2,0]},"heat_target":{"type":"heat_target","offset":[0,-0.35,0]}}'::jsonb,
            assembly_role = 'support'
        WHERE (
            lower(name_tool_vi) LIKE '%giá đỡ%'
            OR lower(name_tool_vi) LIKE '%gia do%'
            OR lower(name_tool_vi) LIKE '%giá thí nghiệm%'
            OR lower(name_tool_vi) LIKE '%gia thi nghiem%'
            OR lower(name_tool_vi) LIKE '%kiềng ba chân%'
            OR lower(name_tool_vi) LIKE '%kieng ba chan%'
            OR lower(name_tool_vi) LIKE '%chân đế%'
            OR lower(name_tool_vi) LIKE '%chan de%'
            OR lower(name_tool_en) LIKE '%tripod stand%'
            OR lower(name_tool_en) LIKE '%lab stand%'
            OR lower(name_tool_en) LIKE '%support stand%'
            OR lower(name_tool_en) LIKE '%ring stand%'
          )
    """)

    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'clamp_tool',
            is_heating_source = false,
            heating_power = 0,
            max_temperature = 25,
            is_toggleable = false,
            is_support_stand = false,
            can_support_tools = false,
            capabilities = '["clamp"]'::jsonb,
            attach_points = '{"clamp_point":{"type":"clamp_point","offset":[0,0.15,0]}}'::jsonb,
            assembly_role = 'clamp'
        WHERE (tool_type IS NULL OR tool_type = 'unknown')
          AND (
            lower(name_tool_vi) LIKE '%kep%'
            OR lower(name_tool_en) LIKE '%clamp%'
            OR lower(name_tool_en) LIKE '%bosshead%'
          )
    """)

    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'dropping_funnel',
            capabilities = '["contain_liquid","drop_liquid"]'::jsonb,
            ports = '{"opening":{"type":"liquid_in","offset":[0,0.5,0]},"liquid_out":{"type":"liquid_out","offset":[0,-0.5,0]}}'::jsonb,
            attach_points = '{"clamp_target":{"type":"clamp_target","offset":[0,0.2,0]}}'::jsonb,
            assembly_role = 'liquid_feeder'
        WHERE (tool_type IS NULL OR tool_type = 'unknown')
          AND (
            lower(name_tool_vi) LIKE '%pheu nho giot%'
            OR lower(name_tool_en) LIKE '%dropping funnel%'
            OR lower(name_tool_en) LIKE '%addition funnel%'
          )
    """)

    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'gas_tube',
            capabilities = '["transfer_gas"]'::jsonb,
            ports = '{"gas_in":{"type":"gas_in","offset":[-0.5,0,0]},"gas_out":{"type":"gas_out","offset":[0.5,0,0]}}'::jsonb,
            assembly_role = 'gas_transfer'
        WHERE (tool_type IS NULL OR tool_type = 'unknown')
          AND (
            lower(name_tool_vi) LIKE '%ong dan khi%'
            OR lower(name_tool_en) LIKE '%gas tube%'
            OR lower(name_tool_en) LIKE '%delivery tube%'
            OR lower(name_tool_en) LIKE '%rubber tubing%'
            OR lower(name_tool_en) LIKE '%glass tubing%'
          )
    """)

    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'gas_collector',
            capabilities = '["collect_gas","contain_gas"]'::jsonb,
            ports = '{"gas_in":{"type":"gas_in","offset":[0,0.8,0]}}'::jsonb,
            assembly_role = 'gas_collector'
        WHERE (tool_type IS NULL OR tool_type = 'unknown')
          AND (
            lower(name_tool_vi) LIKE '%binh thu khi%'
            OR lower(name_tool_en) LIKE '%gas jar%'
            OR lower(name_tool_en) LIKE '%gas collector%'
            OR lower(name_tool_en) LIKE '%collection bottle%'
          )
    """)

    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'heating_source',
            is_heating_source = true,
            heating_power = 8,
            max_temperature = 120,
            is_toggleable = true,
            is_support_stand = false,
            can_support_tools = false,
            capabilities = '["heat"]'::jsonb,
            attach_points = '{"heating_zone":{"type":"heating_zone","offset":[0,0.3,0]}}'::jsonb,
            assembly_role = 'heating_source'
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
    """)
    _safe_exec(session, f"""
        UPDATE {table_name}
        SET
            tool_type = 'container',
            is_heating_source = false,
            heating_power = 0,
            max_temperature = 25,
            is_toggleable = false,
            is_support_stand = false,
            can_support_tools = false,
            capabilities = '["contain_liquid","contain_solid","receive_liquid","react","heat_target"]'::jsonb,
            ports = '{"opening":{"type":"opening","offset":[0,1,0]},"gas_out":{"type":"gas_out","offset":[0.3,1,0]}}'::jsonb,
            attach_points = '{"bottom":{"type":"support_target","offset":[0,-0.5,0]},"clamp_target":{"type":"clamp_target","offset":[0,0.45,0]},"heat_target":{"type":"heat_target","offset":[0,-0.45,0]}}'::jsonb,
            assembly_role = 'reaction_vessel'
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
    """)
