from dataclasses import dataclass
import json
import logging
import re
import unicodedata

from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint, HuggingFaceEmbeddings
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, AIMessage
from langchain_postgres import PGVector
from langchain.agents import create_agent
from sqlalchemy import create_engine, text

from app.config import DATABASE_URL, HF_TOKEN


logger = logging.getLogger(__name__)

# Khởi tạo LLM. RAG thí nghiệm không còn để LLM tự quyết định lượng/bước;
# LLM chỉ dùng cho câu hỏi thường hoặc khi không tạo được plan mô phỏng.
llm = HuggingFaceEndpoint(
    repo_id="Qwen/Qwen2.5-7B-Instruct",
    task="text-generation",
    temperature=0.2,
    max_new_tokens=1024,
    repetition_penalty=1.15,
    huggingfacehub_api_token=HF_TOKEN,
    stop_sequences=["<|endoftext|>", "<|im_end|>", "User:", "Assistant:"]
)

model = ChatHuggingFace(llm=llm)
embeddings = HuggingFaceEmbeddings(model_name="intfloat/multilingual-e5-base")

connection = DATABASE_URL
db_engine = create_engine(
    connection,
    connect_args={"prepare_threshold": None},
    pool_pre_ping=True
) if connection else None

fallback_vector_store = PGVector(
    embeddings=embeddings,
    connection=connection,
    collection_name="data_chunks"
) if connection else None


@dataclass
class KnowledgeDocument:
    id: str
    content: str
    metadata: dict
    score: float | None
    source_table: str


def clean_repeating_text(text_value: str) -> str:
    """Cắt các đoạn LLM lặp vô hạn hoặc lặp dòng liên tiếp."""
    if not text_value:
        return text_value

    lines = text_value.split("\n")
    cleaned_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            cleaned_lines.append("")
            continue

        n = len(stripped)
        best_len = 0
        best_pos = -1
        for length in range(10, min(300, n // 3)):
            for start in range(n - 3 * length):
                chunk = stripped[start:start + length]
                if (
                    stripped[start + length:start + 2 * length] == chunk and
                    stripped[start + 2 * length:start + 3 * length] == chunk
                ):
                    best_len = length
                    best_pos = start
                    break
            if best_len > 0:
                break

        if best_len > 0:
            indent = line[:len(line) - len(line.lstrip())]
            cleaned_lines.append(indent + stripped[:best_pos + best_len].rstrip(",. ") + "...")
        else:
            cleaned_lines.append(line)

    seen = set()
    unique_lines = []
    for line in cleaned_lines:
        stripped = line.strip()
        if not stripped:
            unique_lines.append("")
            continue
        if len(stripped) > 15 and stripped in seen:
            continue
        seen.add(stripped)
        unique_lines.append(line)
    return "\n".join(unique_lines)


def _normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value or "").lower())
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    normalized = normalized.replace("đ", "d")
    normalized = normalized.replace("₂", "2").replace("₃", "3").replace("₄", "4")
    normalized = normalized.replace("₅", "5").replace("₆", "6").replace("₈", "8")
    normalized = re.sub(r"[()[\]{}]", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _json_metadata(value) -> dict:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(v):.8f}" for v in values) + "]"


def _subject_key(selected_subject: str) -> str:
    subject = _normalize_text(selected_subject or "general")
    if "hoa" in subject or "chem" in subject:
        return "chemistry"
    if "ly" in subject or "phys" in subject:
        return "physics"
    if "sinh" in subject or "bio" in subject:
        return "biology"
    return subject or "general"


def _row_to_doc(row, source_table: str) -> KnowledgeDocument:
    metadata = _json_metadata(getattr(row, "metadata", None))
    score = getattr(row, "score", None)
    try:
        score = float(score) if score is not None else None
    except (TypeError, ValueError):
        score = None
    return KnowledgeDocument(
        id=str(getattr(row, "id", "")),
        content=str(getattr(row, "content", "") or ""),
        metadata=metadata,
        score=score,
        source_table=source_table
    )


def _retrieve_from_langchain_bg_embedding(query: str, subject: str, k: int = 6) -> list[KnowledgeDocument]:
    """Ưu tiên truy vấn trực tiếp bảng langchain_bg_embedding."""
    if not db_engine:
        return []

    query_embedding = embeddings.embed_query(f"query: {query}")
    params = {
        "embedding": _vector_literal(query_embedding),
        "subject": _subject_key(subject),
        "limit": k
    }

    # Hỗ trợ vài biến thể schema phổ biến, nhưng luôn ưu tiên table người dùng yêu cầu.
    sql_variants = [
        """
        SELECT id::text AS id,
               document AS content,
               cmetadata AS metadata,
               1 - (embedding <=> CAST(:embedding AS vector)) AS score
        FROM langchain_bg_embedding
        WHERE cmetadata IS NULL
           OR :subject = ''
           OR lower(coalesce(cmetadata->>'subject', '')) = :subject
           OR (:subject IN ('general', 'chemistry') AND lower(coalesce(cmetadata->>'subject', '')) IN ('chemistry', 'hoa hoc'))
        ORDER BY embedding <=> CAST(:embedding AS vector)
        LIMIT :limit
        """,
        """
        SELECT id::text AS id,
               document AS content,
               cmetadata AS metadata,
               1 - (embedding <=> CAST(:embedding AS vector)) AS score
        FROM langchain_bg_embedding
        ORDER BY embedding <=> CAST(:embedding AS vector)
        LIMIT :limit
        """,
        """
        SELECT id::text AS id,
               content AS content,
               metadata AS metadata,
               1 - (embedding <=> CAST(:embedding AS vector)) AS score
        FROM langchain_bg_embedding
        ORDER BY embedding <=> CAST(:embedding AS vector)
        LIMIT :limit
        """
    ]

    for statement in sql_variants:
        try:
            with db_engine.connect() as conn:
                rows = conn.execute(text(statement), params).fetchall()
            docs = [_row_to_doc(row, "langchain_bg_embedding") for row in rows if getattr(row, "content", None)]
            if docs:
                for doc in docs:
                    logger.info(
                        "RAG retrieved bg_embedding doc id=%s score=%s metadata=%s preview=%s",
                        doc.id,
                        f"{doc.score:.4f}" if doc.score is not None else None,
                        doc.metadata,
                        doc.content[:240].replace("\n", " ")
                    )
                return docs
        except Exception as exc:
            logger.debug("langchain_bg_embedding query variant failed: %s", exc)

    logger.warning("No usable rows retrieved from langchain_bg_embedding for query=%s", query)
    return []


def _retrieve_from_pgvector_fallback(query: str, subject: str, k: int = 6) -> list[KnowledgeDocument]:
    if not fallback_vector_store:
        return []

    docs: list[KnowledgeDocument] = []
    search_filter = {"subject": _subject_key(subject)}
    try:
        results = fallback_vector_store.similarity_search_with_score(
            f"query: {query}",
            k=k,
            filter=search_filter
        )
    except Exception as exc:
        logger.exception("PGVector fallback retrieval failed: %s", exc)
        return []

    for doc, raw_score in results:
        score = None
        try:
            # LangChain PGVector thường trả distance. Quy đổi tương đối để log dễ đọc.
            distance = float(raw_score)
            score = 1 - distance if distance <= 2 else distance
        except (TypeError, ValueError):
            pass
        item = KnowledgeDocument(
            id=str(doc.metadata.get("id") or doc.metadata.get("source") or ""),
            content=str(doc.page_content or ""),
            metadata=dict(doc.metadata or {}),
            score=score,
            source_table="langchain_pg_embedding:data_chunks"
        )
        logger.info(
            "RAG fallback doc id=%s score=%s metadata=%s preview=%s",
            item.id,
            f"{item.score:.4f}" if item.score is not None else None,
            item.metadata,
            item.content[:240].replace("\n", " ")
        )
        docs.append(item)
    return docs


def retrieve_knowledge_documents(query: str, subject: str, k: int = 6) -> list[KnowledgeDocument]:
    docs = _retrieve_from_langchain_bg_embedding(query, subject, k)
    if docs:
        return docs
    return _retrieve_from_pgvector_fallback(query, subject, k)


@tool
def retrieved_context(query: str, subject: str):
    """Tìm kiếm thông tin thí nghiệm, dụng cụ và quy trình trong tài liệu."""
    docs = retrieve_knowledge_documents(query, subject, k=6)
    return "\n\n".join(
        (
            f"Nguồn: {doc.source_table} id={doc.id} score={doc.score}\n"
            f"Metadata: {json.dumps(doc.metadata, ensure_ascii=False)}\n"
            f"Nội dung: {doc.content}"
        )
        for doc in docs
    )


tools = [retrieved_context]

prompt = """
Bạn là Trợ lý Phòng thí nghiệm Ảo (Virtual Lab AI).

Luật nguồn dữ liệu:
1. Luôn gọi tool `retrieved_context` trước khi trả lời.
2. Nếu dữ liệu retrieve có thông tin thí nghiệm, không tự bịa hóa chất, lượng, thứ tự bước, nhiệt độ, xúc tác hoặc hiện tượng.
3. Nếu tài liệu không có dữ liệu đủ để lập thí nghiệm, nói rõ phần thiếu thay vì tự chế.
4. Trả lời bằng tiếng Việt, ngắn gọn, không bọc markdown/JSON.
"""
agent = create_agent(model, tools, system_prompt=prompt)


def _extract_answer_text(raw_answer: str) -> str:
    text_value = clean_repeating_text(raw_answer or "").strip()
    if not text_value:
        return text_value
    try:
        parsed = json.loads(text_value)
        if isinstance(parsed, dict) and parsed.get("answer_text"):
            return clean_repeating_text(str(parsed["answer_text"]))
    except Exception:
        pass
    return text_value


CHEMICAL_REGISTRY_CACHE: dict[str, dict] = {"chemicals": {}, "loaded": False}


def _compact_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalize_text(value))


def _default_quantity_from_db_row(row_data: dict) -> tuple[str, float, float]:
    state = _normalize_text(row_data.get("physical_state"))
    chemical_type = _normalize_text(row_data.get("chemical_type"))

    if any(token in state for token in ["ran", "bot", "solid"]):
        return "g", 0.5, 0.05
    if "indicator" in chemical_type:
        return "ml", 2, 0.2
    if "strong acid" in chemical_type or "strong_acid" in chemical_type:
        return "ml", 5, 0.5
    if "strong base" in chemical_type or "strong_base" in chemical_type:
        return "ml", 5, 0.5
    return "ml", 5, 0.5


def _chemical_alias_candidates(row_data: dict) -> list[str]:
    values = [
        row_data.get("name_vi"),
        row_data.get("formula"),
        row_data.get("chemical_type"),
    ]
    aliases = []
    for value in values:
        if value:
            aliases.append(str(value))

    name_key = _normalize_text(row_data.get("name_vi"))
    if name_key:
        aliases.append(name_key)
        aliases.append(_compact_key(name_key))
    formula_key = _compact_key(row_data.get("formula"))
    if formula_key:
        aliases.append(formula_key)

    # Các alias này được sinh từ tên/công thức trong DB, không phải catalog hardcode.
    if "axit" in name_key and "clohidric" in name_key:
        aliases.extend(["hcl", "hydrochloric acid"])
    if "sunfuric" in name_key or "sulfuric" in name_key:
        aliases.extend(["h2so4", "sulfuric acid"])
    if "axetic" in name_key:
        aliases.extend(["ch3cooh", "acetic acid"])
    if "ancol etylic" in name_key or "etanol" in name_key:
        aliases.extend(["c2h5oh", "ethanol"])
    if "amoniac" in name_key:
        aliases.extend(["nh3", "ammonia"])
    if "natri hydroxit" in name_key or "natri hidroxit" in name_key:
        aliases.extend(["naoh", "sodium hydroxide"])
    if "dong" in name_key and "sunfat" in name_key:
        aliases.extend(["cuso4", "cu so4", "copper(ii) sulfate", "copper sulfate"])
    if "bac nitrat" in name_key:
        aliases.extend(["agno3", "ag no3", "silver nitrate"])
    if "gluco" in name_key:
        aliases.extend(["glucose", "c6h12o6"])

    deduped = []
    seen = set()
    for alias in aliases:
        normalized = _normalize_text(alias)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(alias)
    return deduped


def _build_chemical_record(row_data: dict) -> dict:
    default_unit, default_amount, default_tolerance = _default_quantity_from_db_row(row_data)
    formula_key = _compact_key(row_data.get("formula"))
    name_key = _compact_key(row_data.get("name_vi"))
    canonical_id = formula_key or name_key
    return {
        "canonical_id": canonical_id,
        "id_chemical": row_data.get("id_chemical"),
        "name_vi": row_data.get("name_vi") or row_data.get("formula") or canonical_id,
        "name_en": row_data.get("formula") or row_data.get("name_vi") or canonical_id,
        "formula": row_data.get("formula"),
        "chemical_type": row_data.get("chemical_type"),
        "physical_state": row_data.get("physical_state"),
        "aliases": _chemical_alias_candidates(row_data),
        "default_unit": default_unit,
        "default_amount": default_amount,
        "default_tolerance": default_tolerance
    }


def _fallback_chemical_record(ref: str) -> dict:
    ref_key = _compact_key(ref)
    default_unit, default_amount, default_tolerance = _default_quantity_from_db_row({
        "name_vi": ref,
        "physical_state": "",
        "chemical_type": ""
    })
    return {
        "canonical_id": ref_key,
        "id_chemical": None,
        "name_vi": str(ref),
        "name_en": str(ref),
        "formula": None,
        "chemical_type": None,
        "physical_state": None,
        "aliases": [str(ref), ref_key],
        "default_unit": default_unit,
        "default_amount": default_amount,
        "default_tolerance": default_tolerance
    }


def _load_chemical_registry(force_reload: bool = False) -> dict[str, dict]:
    if CHEMICAL_REGISTRY_CACHE["loaded"] and not force_reload:
        return CHEMICAL_REGISTRY_CACHE["chemicals"]

    registry: dict[str, dict] = {}
    if not db_engine:
        CHEMICAL_REGISTRY_CACHE.update({"chemicals": registry, "loaded": True})
        return registry

    try:
        with db_engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id_chemical::text AS id_chemical,
                       name_vi,
                       formula,
                       physical_state,
                       chemical_type,
                       description
                FROM chemicals
                ORDER BY name_vi
            """)).mappings().all()
    except Exception as exc:
        logger.exception("Failed to load chemicals registry from DB: %s", exc)
        CHEMICAL_REGISTRY_CACHE.update({"chemicals": registry, "loaded": True})
        return registry

    for row in rows:
        record = _build_chemical_record(dict(row))
        keys = {
            record["canonical_id"],
            _compact_key(record["name_vi"]),
            _compact_key(record.get("formula")),
            *(_compact_key(alias) for alias in record["aliases"])
        }
        for key in keys:
            if key:
                registry[key] = record

    CHEMICAL_REGISTRY_CACHE.update({"chemicals": registry, "loaded": True})
    logger.info(
        "Loaded %s chemical aliases from chemicals table for RAG parser",
        len(registry)
    )
    return registry


def _resolve_chemical(ref: str) -> dict:
    registry = _load_chemical_registry()
    ref_key = _compact_key(ref)
    if ref_key in registry:
        return registry[ref_key]

    normalized_ref = _normalize_text(ref)
    for record in registry.values():
        if any(_normalize_text(alias) == normalized_ref for alias in record.get("aliases", [])):
            return record
    logger.warning("Chemical ref '%s' was not found in chemicals table; using transient fallback record", ref)
    return _fallback_chemical_record(ref)


EXPERIMENT_TEMPLATES = [
    {
        "experiment_id": "prepare_h2_from_na_hcl",
        "reaction_id": "sodium_acid_first",
        "title": "Điều chế khí hidro từ natri và axit clohidric",
        "aliases": ["natri hcl", "natri axit clohidric", "na hcl", "điều chế hidro", "sodium acid"],
        "chemical_ids": ["hcl", "na"],
        "default_steps": ["hcl", "na"],
        "success_message": "Natri phản ứng với axit, sủi bọt khí hidro và tỏa nhiệt.",
        "phenomenon_keywords": ["sủi bọt", "khí hidro", "h2", "tỏa nhiệt"]
    },
    {
        "experiment_id": "copper_sulfate_ammonia",
        "reaction_id": "cu_so4_nh3_limited",
        "title": "Đồng(II) sunfat tác dụng với amoniac",
        "aliases": ["cuso4 nh3", "đồng ii sunfat amoniac", "đồng(II) sunfat nh3", "copper sulfate ammonia"],
        "chemical_ids": ["cuso4", "nh3"],
        "default_steps": ["cuso4", "nh3"],
        "success_message": "Xuất hiện kết tủa xanh lam Cu(OH)2; nếu NH3 dư, kết tủa tan tạo dung dịch xanh thẫm.",
        "phenomenon_keywords": ["kết tủa xanh", "xanh lam", "xanh thẫm", "cu(oh)2"]
    },
    {
        "experiment_id": "silver_mirror_tollens_glucose",
        "reaction_id": "silver_mirror_from_tollens_glucose_heat",
        "title": "Phản ứng tráng gương của glucozơ",
        "aliases": ["tráng gương", "trang guong", "tollens", "agno3 nh3 gluco", "phản ứng tráng bạc"],
        "chemical_ids": ["agno3", "nh3", "glucose"],
        "default_steps": ["agno3", "nh3", "glucose", "heat"],
        "temperature_min": 45,
        "heating_required": True,
        "success_message": "Glucozơ khử phức bạc amoniac khi đun nóng, tạo lớp bạc sáng bám trong ống nghiệm.",
        "phenomenon_keywords": ["lớp bạc", "gương bạc", "bạc sáng", "tráng gương"]
    },
    {
        "experiment_id": "ethyl_acetate_esterification",
        "reaction_id": "ethyl_acetate_esterification",
        "title": "Este hóa axit axetic với ancol etylic",
        "aliases": ["este hóa", "este hoa", "ethyl acetate", "axit axetic ancol etylic", "ch3cooh c2h5oh"],
        "chemical_ids": ["ch3cooh", "c2h5oh", "h2so4"],
        "default_steps": ["ch3cooh", "c2h5oh", "h2so4", "heat"],
        "roles": {"h2so4": "catalyst"},
        "temperature_min": 80,
        "heating_required": True,
        "success_message": "Có mùi thơm este; etyl axetat tạo thành và có thể tách thành lớp nhẹ phía trên.",
        "phenomenon_keywords": ["mùi thơm", "este", "tách lớp", "etyl axetat"]
    },
    {
        "experiment_id": "phenolphthalein_naoh_indicator",
        "reaction_id": "phenolphthalein_base_pink",
        "title": "Phenolphthalein đổi màu trong dung dịch natri hydroxit",
        "aliases": ["phenolphthalein naoh", "phenolphthalein natri hydroxit", "chỉ thị phenolphthalein", "phenolphtalein naoh"],
        "chemical_ids": ["phenolphthalein", "naoh"],
        "default_steps": ["phenolphthalein", "naoh"],
        "success_message": "Phenolphthalein chuyển sang màu hồng trong môi trường bazơ.",
        "phenomenon_keywords": ["màu hồng", "hồng cánh sen", "bazơ", "kiềm"]
    }
]


def _is_chemistry_subject(selected_subject: str) -> bool:
    subject = _normalize_text(selected_subject or "general")
    return not subject or any(token in subject for token in ["general", "chem", "hoa"])


def _is_experiment_question(question: str) -> bool:
    haystack = _normalize_text(question)
    trigger_words = [
        "thi nghiem", "thuc hien", "lam", "dieu che", "phan ung", "rot",
        "them", "trang guong", "este", "hien tuong", "tao ket tua", "doi mau"
    ]
    if any(word in haystack for word in trigger_words):
        return True
    return _identify_template(question, []) is not None


def _fail_messages() -> dict:
    return {
        "wrong_chemical": "Bạn đã dùng sai hóa chất.",
        "missing_chemical": "Bạn chưa lấy đủ hóa chất cần thiết.",
        "wrong_amount": "Khối lượng hoặc thể tích chưa đúng.",
        "wrong_order": "Bạn đã thực hiện sai thứ tự thao tác.",
        "wrong_temperature": "Điều kiện nhiệt độ chưa phù hợp.",
        "wrong_reaction": "Phản ứng tạo ra không khớp thí nghiệm đã chọn."
    }


def _chem(chemical_id: str, amount: float, unit: str, tolerance: float | None = None, role: str = "reactant") -> dict:
    base = _resolve_chemical(chemical_id)
    resolved_tolerance = tolerance if tolerance is not None else (
        base["default_tolerance"] if unit == base["default_unit"] else (0.5 if unit == "ml" else 0.05)
    )
    return {
        "canonical_id": base["canonical_id"],
        "name_vi": base["name_vi"],
        "name_en": base["name_en"],
        "amount": float(amount),
        "unit": unit,
        "tolerance": float(resolved_tolerance),
        "role": role
    }


def _step(
    step: int,
    chemical_id: str | None,
    amount: float | None,
    unit: str | None,
    action_type: str | None = None,
    tolerance: float | None = None,
    auto_stop: bool = True,
    heating_required: bool = False,
    target_temperature=None,
    action_description: str | None = None
) -> dict:
    if chemical_id:
        chemical = _resolve_chemical(chemical_id)
        normalized_action = action_type or ("add" if unit == "g" else "pour")
        verb = "Thêm" if normalized_action == "add" else "Rót"
        return {
            "step_order": step,
            "chemical_name_vi": chemical["name_vi"],
            "canonical_id": chemical["canonical_id"],
            "id_chemical": None,
            "id_tool": None,
            "action_type": normalized_action,
            "target_amount": float(amount) if amount is not None else None,
            "unit": unit,
            "tolerance": float(tolerance) if tolerance is not None else (0.05 if unit == "g" else 0.5),
            "auto_stop": auto_stop,
            "heating_required": heating_required,
            "target_temperature": target_temperature,
            "action_description": action_description or f"{verb} {amount:g} {unit} {chemical['name_vi']} vào dụng cụ phản ứng."
        }

    return {
        "step_order": step,
        "chemical_name_vi": None,
        "canonical_id": None,
        "id_chemical": None,
        "id_tool": None,
        "action_type": action_type or "heat",
        "target_amount": None,
        "unit": "°C",
        "tolerance": 2,
        "auto_stop": auto_stop,
        "heating_required": True,
        "target_temperature": target_temperature,
        "action_description": action_description or f"Đun nóng đến khoảng {target_temperature:g}°C."
    }


def _legacy_step(step: dict) -> dict:
    if step.get("action_type") == "heat":
        return {
            "step": step["step_order"],
            "action": "heat",
            "temperature_min": step.get("target_temperature")
        }
    return {
        "step": step["step_order"],
        "action": "add_chemical",
        "chemical": step.get("chemical_name_vi"),
        "canonical_id": step.get("canonical_id"),
        "amount": step.get("target_amount"),
        "unit": step.get("unit")
    }


def _plan(
    experiment_id: str,
    title: str,
    chemicals: list[dict],
    steps: list[dict],
    reaction_id: str,
    success_message: str,
    tools: list[str] | None = None,
    phenomenon: str | None = None,
    source_priority: str = "fallback_default",
    source_documents: list[dict] | None = None,
    temperature_min=None,
    temperature_max=None,
    heating_required: bool = False,
    order_required: bool = True
) -> dict:
    required_by_id = {item["canonical_id"]: item for item in chemicals}
    enriched_steps = []
    for item in steps:
        step = dict(item)
        canonical_id = step.get("canonical_id")
        if canonical_id in required_by_id:
            required = required_by_id[canonical_id]
            step["target_amount"] = required["amount"]
            step["unit"] = required["unit"]
            step["tolerance"] = required["tolerance"]
            step["chemical_name_vi"] = required["name_vi"]
        enriched_steps.append(step)

    plan = {
        "experiment_id": experiment_id,
        "reaction_id": reaction_id,
        "title": title,
        "steps": enriched_steps,
        "required_chemicals": chemicals,
        "required_tools": tools or ["Ống nghiệm hoặc cốc thủy tinh", "Giá đỡ", "Ống nhỏ giọt/đũa thủy tinh"],
        "required_conditions": {
            "temperature_min": temperature_min,
            "temperature_max": temperature_max,
            "heating_required": heating_required,
            "order_required": order_required,
            "steps": [_legacy_step(step) for step in enriched_steps]
        },
        "success_reaction_id": reaction_id,
        "success_message": success_message,
        "phenomenon": phenomenon or success_message,
        "fail_messages": _fail_messages(),
        "knowledge_source_priority": source_priority,
        "source_documents": source_documents or []
    }
    logger.info("Generated experiment_plan: %s", json.dumps(plan, ensure_ascii=False))
    return plan


def _format_amount(value) -> str:
    try:
        number = float(value)
        return f"{number:g}"
    except (TypeError, ValueError):
        return str(value)


def _format_answer_from_plan(plan: dict, fallback: str = "") -> str:
    if not plan:
        return fallback

    chemical_lines = [
        f"- {item['name_vi']}: {_format_amount(item['amount'])} {item['unit']} (sai số ±{_format_amount(item['tolerance'])} {item['unit']})"
        for item in plan.get("required_chemicals", [])
    ]

    step_lines = [
        f"Bước {step['step_order']}: {step['action_description']}"
        for step in sorted(plan.get("steps", []), key=lambda value: value.get("step_order") or 0)
    ]

    condition_lines = []
    conditions = plan.get("required_conditions", {})
    if conditions.get("heating_required"):
        condition_lines.append(f"- Cần đun nóng đến tối thiểu {_format_amount(conditions.get('temperature_min'))}°C.")
    catalyst = [item["name_vi"] for item in plan.get("required_chemicals", []) if item.get("role") == "catalyst"]
    if catalyst:
        condition_lines.append(f"- Chất xúc tác: {', '.join(catalyst)}.")
    if not condition_lines:
        condition_lines.append("- Không cần đun nóng hoặc xúc tác đặc biệt.")

    return (
        f"Tên thí nghiệm: {plan['title']}\n\n"
        f"Hóa chất cần dùng:\n" + "\n".join(chemical_lines) + "\n\n"
        f"Dụng cụ cần dùng: {', '.join(plan.get('required_tools') or [])}.\n\n"
        f"Thứ tự thực hiện:\n" + "\n".join(step_lines) + "\n\n"
        f"Điều kiện:\n" + "\n".join(condition_lines) + "\n\n"
        f"Hiện tượng: {plan.get('phenomenon') or plan.get('success_message')}"
    )


def _doc_brief(doc: KnowledgeDocument) -> dict:
    return {
        "id": doc.id,
        "source_table": doc.source_table,
        "score": doc.score,
        "metadata": doc.metadata
    }


def _identify_template(question: str, docs: list[KnowledgeDocument]) -> dict | None:
    haystack = _normalize_text(question + "\n" + "\n".join(doc.content[:1200] for doc in docs[:3]))
    best_template = None
    best_score = 0
    for template in EXPERIMENT_TEMPLATES:
        score = 0
        for alias in template["aliases"]:
            if _normalize_text(alias) in haystack:
                score += 4
        for chemical_id in template["chemical_ids"]:
            chemical = _resolve_chemical(chemical_id)
            if any(_normalize_text(alias) in haystack for alias in chemical["aliases"]):
                score += 1
        if score > best_score:
            best_template = template
            best_score = score
    return best_template if best_score >= 2 else None


AMOUNT_RE = re.compile(
    r"(?P<amount>\d+(?:[\.,]\d+)?)\s*(?P<unit>ml|mL|mililit|g|gam|gram|mg|giọt|giot)\b",
    re.IGNORECASE
)


def _normalize_unit(unit: str, amount: float) -> tuple[float, str]:
    unit_key = _normalize_text(unit)
    if unit_key in {"g", "gam", "gram"}:
        return amount, "g"
    if unit_key == "mg":
        return amount / 1000, "g"
    if unit_key in {"giot", "giọt"}:
        return amount * 0.05, "ml"
    return amount, "ml"


def _chemical_aliases(chemical_id: str) -> list[str]:
    chemical = _resolve_chemical(chemical_id)
    return [_normalize_text(alias) for alias in [chemical["name_vi"], chemical["name_en"], *chemical["aliases"]]]


def _find_positions(text_value: str, chemical_id: str) -> list[int]:
    normalized = _normalize_text(text_value)
    positions = []
    for alias in _chemical_aliases(chemical_id):
        if not alias:
            continue
        start = 0
        while True:
            index = normalized.find(alias, start)
            if index < 0:
                break
            positions.append(index)
            start = index + len(alias)
    return positions


def _extract_amount_for_chemical(content: str, chemical_id: str):
    normalized = _normalize_text(content)
    alias_positions = _find_positions(content, chemical_id)
    if not alias_positions:
        return None

    candidates = []
    for match in AMOUNT_RE.finditer(content):
        amount = float(match.group("amount").replace(",", "."))
        amount, unit = _normalize_unit(match.group("unit"), amount)
        norm_prefix = _normalize_text(content[:match.start()])
        norm_start = len(norm_prefix)
        nearest = min(abs(norm_start - pos) for pos in alias_positions)
        window_start = max(0, norm_start - 110)
        window_end = min(len(normalized), norm_start + 110)
        window = normalized[window_start:window_end]
        if any(alias in window for alias in _chemical_aliases(chemical_id)):
            candidates.append((nearest, norm_start, amount, unit, match.group(0)))

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    _, position, amount, unit, evidence = candidates[0]
    return {
        "amount": amount,
        "unit": unit,
        "position": position,
        "evidence": evidence
    }


def _extract_temperature(content: str):
    normalized = _normalize_text(content)
    temp_match = re.search(r"(\d+(?:[\.,]\d+)?)\s*(?:°\s*c|do\s*c|c)\b", normalized)
    if temp_match:
        return float(temp_match.group(1).replace(",", "."))
    if any(token in normalized for token in ["dun nong", "cach thuy", "gia nhiet", "lam nong"]):
        return None
    return None


def _extract_procedure_section(content: str) -> str:
    normalized = _normalize_text(content)
    headings = ["cach tien hanh", "tien hanh", "thuc hien", "cac buoc", "thi nghiem"]
    indexes = [normalized.find(heading) for heading in headings if normalized.find(heading) >= 0]
    if not indexes:
        return content
    start_norm = min(indexes)
    # Dùng tỉ lệ vị trí normalized/original đủ tốt để cắt vùng thủ tục.
    ratio = len(content) / max(1, len(normalized))
    return content[int(start_norm * ratio):]


def _extract_step_order(content: str, template: dict, amount_by_chemical: dict) -> list[str]:
    procedure = _extract_procedure_section(content)
    positions = []
    for chemical_id in template["chemical_ids"]:
        found_positions = _find_positions(procedure, chemical_id)
        if found_positions:
            positions.append((min(found_positions), chemical_id))
        elif chemical_id in amount_by_chemical:
            positions.append((amount_by_chemical[chemical_id]["position"], chemical_id))

    if len(positions) >= len(template["chemical_ids"]):
        ordered = [chemical_id for _, chemical_id in sorted(positions, key=lambda item: item[0])]
        return [item for item in ordered if item in template["chemical_ids"]]

    return [item for item in template["default_steps"] if item != "heat"]


def _extract_phenomenon(content: str, template: dict) -> str | None:
    normalized = _normalize_text(content)
    markers = ["hien tuong", "quan sat", "ket qua", "nhan xet"]
    for marker in markers:
        index = normalized.find(marker)
        if index < 0:
            continue
        ratio = len(content) / max(1, len(normalized))
        original_index = int(index * ratio)
        snippet = content[original_index:original_index + 260]
        snippet = re.sub(r"\s+", " ", snippet)
        snippet = re.sub(r"^(Hiện tượng|Quan sát|Kết quả|Nhận xét)\s*[:\-]?\s*", "", snippet, flags=re.IGNORECASE)
        if snippet:
            return snippet.strip(" .;:")

    for keyword in template.get("phenomenon_keywords", []):
        key = _normalize_text(keyword)
        index = normalized.find(key)
        if index >= 0:
            ratio = len(content) / max(1, len(normalized))
            original_index = int(index * ratio)
            snippet = re.sub(r"\s+", " ", content[max(0, original_index - 80):original_index + 180])
            return snippet.strip(" .;:")
    return None


def _parse_plan_from_documents(question: str, docs: list[KnowledgeDocument]) -> dict | None:
    bg_docs = [doc for doc in docs if doc.source_table == "langchain_bg_embedding"]
    if not bg_docs:
        return None
    template = _identify_template(question, bg_docs)
    if not template:
        return None

    best_doc = None
    best_amounts = None
    for doc in bg_docs:
        amount_by_chemical = {
            chemical_id: amount
            for chemical_id in template["chemical_ids"]
            if (amount := _extract_amount_for_chemical(doc.content, chemical_id))
        }
        logger.info(
            "Parsed amounts from doc id=%s experiment=%s amounts=%s",
            doc.id,
            template["experiment_id"],
            amount_by_chemical
        )
        if len(amount_by_chemical) == len(template["chemical_ids"]):
            best_doc = doc
            best_amounts = amount_by_chemical
            break

    if not best_doc or not best_amounts:
        logger.info(
            "langchain_bg_embedding did not contain enough amounts for experiment=%s; fallback allowed",
            template["experiment_id"]
        )
        return None

    role_by_id = template.get("roles", {})
    chemicals = []
    for chemical_id in template["chemical_ids"]:
        parsed = best_amounts[chemical_id]
        chemicals.append(
            _chem(
                chemical_id,
                parsed["amount"],
                parsed["unit"],
                role=role_by_id.get(chemical_id, "reactant")
            )
        )

    step_ids = _extract_step_order(best_doc.content, template, best_amounts)
    target_temperature = _extract_temperature(best_doc.content)
    if target_temperature is None:
        target_temperature = template.get("temperature_min")
    heating_required = bool(template.get("heating_required")) or any(
        token in _normalize_text(best_doc.content)
        for token in ["dun nong", "cach thuy", "gia nhiet"]
    )

    steps = []
    for chemical_id in step_ids:
        parsed = best_amounts[chemical_id]
        steps.append(_step(len(steps) + 1, chemical_id, parsed["amount"], parsed["unit"]))
    if heating_required:
        steps.append(
            _step(
                len(steps) + 1,
                None,
                None,
                None,
                action_type="heat",
                target_temperature=target_temperature or 80,
                action_description=f"Đun nóng đến tối thiểu {_format_amount(target_temperature or 80)}°C."
            )
        )

    phenomenon = _extract_phenomenon(best_doc.content, template) or template["success_message"]
    source_documents = [_doc_brief(best_doc)]
    logger.info(
        "Using langchain_bg_embedding as source of truth for experiment=%s source=%s",
        template["experiment_id"],
        source_documents
    )
    return _plan(
        template["experiment_id"],
        template["title"],
        chemicals,
        steps,
        template["reaction_id"],
        template["success_message"],
        phenomenon=phenomenon,
        source_priority="langchain_bg_embedding",
        source_documents=source_documents,
        temperature_min=target_temperature,
        heating_required=heating_required
    )


def _build_template_fallback_plan(question: str, answer_text: str, docs: list[KnowledgeDocument]) -> dict | None:
    template = _identify_template(question + "\n" + answer_text, docs)
    if not template:
        return None

    role_by_id = template.get("roles", {})
    chemicals = []
    for chemical_id in template["chemical_ids"]:
        chemical = _resolve_chemical(chemical_id)
        chemicals.append(
            _chem(
                chemical_id,
                chemical["default_amount"],
                chemical["default_unit"],
                chemical["default_tolerance"],
                role_by_id.get(chemical_id, "reactant")
            )
        )
    steps = []
    for item in template["default_steps"]:
        if item == "heat":
            steps.append(
                _step(
                    len(steps) + 1,
                    None,
                    None,
                    None,
                    action_type="heat",
                    target_temperature=template.get("temperature_min") or 80,
                    action_description=f"Đun nóng đến tối thiểu {_format_amount(template.get('temperature_min') or 80)}°C."
                )
            )
            continue
        chemical = _resolve_chemical(item)
        steps.append(
            _step(
                len(steps) + 1,
                item,
                chemical["default_amount"],
                chemical["default_unit"]
            )
        )

    logger.warning(
        "Using ReactionDatabase/default fallback for experiment=%s because bg_embedding was missing complete data",
        template["experiment_id"]
    )
    return _plan(
        template["experiment_id"],
        template["title"],
        chemicals,
        steps,
        template["reaction_id"],
        template["success_message"],
        phenomenon=template["success_message"],
        source_priority="ReactionDatabase.js/default_simulation_values",
        source_documents=[_doc_brief(doc) for doc in docs[:3]],
        temperature_min=template.get("temperature_min"),
        heating_required=bool(template.get("heating_required"))
    )


def _build_generic_plan_from_text(question: str, answer_text: str) -> dict | None:
    haystack = _normalize_text(f"{question}\n{answer_text}")
    found = []
    unique_chemicals = {}
    for chemical in _load_chemical_registry().values():
        unique_chemicals[chemical["canonical_id"]] = chemical
    for chemical_id, chemical in unique_chemicals.items():
        if any(_normalize_text(alias) in haystack for alias in chemical["aliases"]):
            parsed = _extract_amount_for_chemical(f"{question}\n{answer_text}", chemical_id)
            amount = parsed["amount"] if parsed else chemical["default_amount"]
            unit = parsed["unit"] if parsed else chemical["default_unit"]
            found.append((parsed["position"] if parsed else 9999, chemical_id, amount, unit))
    if not found:
        return None

    ordered = []
    seen = set()
    for _, chemical_id, amount, unit in sorted(found, key=lambda item: item[0]):
        if chemical_id in seen:
            continue
        seen.add(chemical_id)
        ordered.append((chemical_id, amount, unit))

    chemicals = [_chem(chemical_id, amount, unit) for chemical_id, amount, unit in ordered]
    steps = [_step(index + 1, chemical_id, amount, unit) for index, (chemical_id, amount, unit) in enumerate(ordered)]
    return _plan(
        "rag_generated_experiment",
        "Thí nghiệm theo hướng dẫn Mascot/RAG",
        chemicals,
        steps,
        "rag_validated_reaction",
        "Thí nghiệm thành công khi thực hiện đúng hóa chất, đúng lượng và đúng thứ tự.",
        source_priority="fallback_default"
    )


def build_experiment_plan(
    question: str,
    answer_text: str,
    selected_subject: str = "Chemistry",
    retrieved_docs: list[KnowledgeDocument] | None = None
):
    """Tạo experiment_plan chuẩn hóa theo thứ tự ưu tiên dữ liệu."""
    if not _is_chemistry_subject(selected_subject):
        return None

    docs = retrieved_docs or []
    haystack = _normalize_text(f"{question}\n{answer_text}")
    if not _is_experiment_question(question) and not any(
        token in haystack
        for token in ["thi nghiem", "phan ung", "hien tuong", "hoa chat", "dun nong"]
    ):
        return None

    plan = _parse_plan_from_documents(question, docs)
    if plan:
        return plan

    plan = _build_template_fallback_plan(question, answer_text, docs)
    if plan:
        return plan

    return _build_generic_plan_from_text(question, answer_text)


def validate_answer_matches_plan(answer_text: str, plan: dict | None) -> dict:
    if not plan:
        return {"ok": True, "issues": []}

    normalized_answer = _normalize_text(answer_text)
    issues = []
    for step in plan.get("steps", []):
        if step.get("action_type") == "heat":
            temperature = step.get("target_temperature")
            if temperature is not None and _format_amount(temperature) not in normalized_answer:
                issues.append(f"answer_text thiếu nhiệt độ {temperature}°C")
            continue
        name = step.get("chemical_name_vi")
        amount = _format_amount(step.get("target_amount"))
        unit = step.get("unit")
        if _normalize_text(name) not in normalized_answer:
            issues.append(f"answer_text thiếu hóa chất {name}")
        if amount not in normalized_answer or _normalize_text(unit) not in normalized_answer:
            issues.append(f"answer_text thiếu lượng {amount} {unit} của {name}")

    result = {"ok": not issues, "issues": issues}
    logger.info("Consistency answer_text_vs_plan result=%s", result)
    return result


def validate_plan_against_documents(plan: dict | None, docs: list[KnowledgeDocument]) -> dict:
    if not plan or plan.get("knowledge_source_priority") != "langchain_bg_embedding":
        return {"ok": True, "issues": []}

    content = "\n".join(doc.content for doc in docs[:3])
    normalized_content = _normalize_text(content)
    issues = []
    for chemical in plan.get("required_chemicals", []):
        aliases = _chemical_aliases(chemical["canonical_id"])
        if not any(alias in normalized_content for alias in aliases):
            issues.append(f"document thiếu hóa chất {chemical['name_vi']}")
        parsed = _extract_amount_for_chemical(content, chemical["canonical_id"])
        if not parsed:
            issues.append(f"document thiếu lượng của {chemical['name_vi']}")
            continue
        if abs(float(parsed["amount"]) - float(chemical["amount"])) > 1e-6 or parsed["unit"] != chemical["unit"]:
            issues.append(f"plan lệch lượng document cho {chemical['name_vi']}")

    result = {"ok": not issues, "issues": issues}
    logger.info("Consistency plan_vs_langchain_bg_embedding result=%s", result)
    return result


def ask_questions(question: str, selected_subject: str, history: list = None):
    """Trả lời câu hỏi thường bằng agent RAG."""
    input_messages = []

    if history:
        for msg in history:
            if isinstance(msg, dict):
                role = msg.get("role")
                content = msg.get("content") or msg.get("context")
            else:
                role, content = msg

            if role == "user":
                input_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                input_messages.append(AIMessage(content=content))

    subject = (selected_subject or "general").lower()
    input_messages.append(HumanMessage(content=f"[Môn học: {subject}] {question}"))

    try:
        response = agent.invoke({"messages": input_messages})
        return _extract_answer_text(response["messages"][-1].content)
    except Exception as exc:
        logger.exception("Error in ask_questions: %s", exc)
        return "Xin lỗi, mình gặp chút trục trặc khi xử lý câu hỏi. Bạn thử lại nhé!"


def ask_questions_with_plan(question: str, selected_subject: str, history: list = None):
    docs = retrieve_knowledge_documents(question, selected_subject, k=6)

    if _is_chemistry_subject(selected_subject) and _is_experiment_question(question):
        plan = build_experiment_plan(question, "", selected_subject, retrieved_docs=docs)
        if plan:
            answer_text = _format_answer_from_plan(plan)
            validations = {
                "answer_text_vs_plan": validate_answer_matches_plan(answer_text, plan),
                "plan_vs_langchain_bg_embedding": validate_plan_against_documents(plan, docs)
            }
            logger.info("RAG consistency validation result=%s", validations)
            return {
                "answer_text": answer_text,
                "experiment_plan": plan,
                "retrieved_documents": [_doc_brief(doc) for doc in docs],
                "consistency_validation": validations
            }

    answer = ask_questions(question, selected_subject=selected_subject, history=history)
    plan = build_experiment_plan(question, answer, selected_subject, retrieved_docs=docs)
    answer_text = _format_answer_from_plan(plan, answer) if plan else answer
    validations = {
        "answer_text_vs_plan": validate_answer_matches_plan(answer_text, plan),
        "plan_vs_langchain_bg_embedding": validate_plan_against_documents(plan, docs)
    }
    logger.info("RAG consistency validation result=%s", validations)
    return {
        "answer_text": answer_text,
        "experiment_plan": plan,
        "retrieved_documents": [_doc_brief(doc) for doc in docs],
        "consistency_validation": validations
    }
