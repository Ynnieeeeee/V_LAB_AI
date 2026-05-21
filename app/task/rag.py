from dataclasses import dataclass
import json
import logging
import re
import unicodedata

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langchain_huggingface import ChatHuggingFace, HuggingFaceEmbeddings, HuggingFaceEndpoint
from langchain_postgres import PGVector
from sqlalchemy import create_engine, text

from app.config import DATABASE_URL, HF_TOKEN


logger = logging.getLogger(__name__)

NO_EXPERIMENT_DATA_MESSAGE = "Không tìm thấy dữ liệu thí nghiệm phù hợp."
MIN_VECTOR_SCORE = 0.18
MIN_LEXICAL_OVERLAP = 0.12
MAX_SELECTED_CONTEXT_CHARS = 12000

llm = HuggingFaceEndpoint(
    repo_id="Qwen/Qwen2.5-7B-Instruct",
    task="text-generation",
    temperature=0.0,
    max_new_tokens=1400,
    repetition_penalty=1.1,
    huggingfacehub_api_token=HF_TOKEN,
    stop_sequences=["<|endoftext|>", "<|im_end|>", "User:", "Assistant:"],
)

model = ChatHuggingFace(llm=llm)
embeddings = HuggingFaceEmbeddings(model_name="intfloat/multilingual-e5-base")

connection = DATABASE_URL
db_engine = create_engine(
    connection,
    connect_args={"prepare_threshold": None},
    pool_pre_ping=True,
) if connection else None

fallback_vector_store = PGVector(
    embeddings=embeddings,
    connection=connection,
    collection_name="data_chunks",
) if connection else None


@dataclass
class KnowledgeDocument:
    id: str
    content: str
    metadata: dict
    score: float | None
    source_table: str
    lexical_overlap: float = 0.0
    selected_score: float = 0.0


def clean_repeating_text(text_value: str) -> str:
    if not text_value:
        return text_value
    lines = []
    seen = set()
    for line in text_value.splitlines():
        stripped = line.strip()
        if len(stripped) > 20 and stripped in seen:
            continue
        seen.add(stripped)
        lines.append(line)
    return "\n".join(lines).strip()


def _normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value or "").lower())
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    normalized = normalized.replace("đ", "d")
    normalized = normalized.replace("₂", "2").replace("₃", "3").replace("₄", "4")
    normalized = normalized.replace("₅", "5").replace("₆", "6").replace("₈", "8")
    normalized = re.sub(r"[()[\]{}]", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _compact_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _normalize_text(value))


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
        source_table=source_table,
    )


STOPWORDS = {
    "thi", "nghiem", "thuc", "hien", "lam", "cach", "cho", "voi", "va",
    "nhan", "biet", "dieu", "che", "phan", "ung", "hoa", "hoc", "hay",
    "giup", "minh", "trong", "the", "nao", "dung", "chat", "dung", "dich",
}


def _query_terms(query: str) -> set[str]:
    tokens = set(re.findall(r"[a-z0-9]{2,}", _normalize_text(query)))
    return {token for token in tokens if token not in STOPWORDS}


def _lexical_overlap(query: str, content: str) -> float:
    terms = _query_terms(query)
    if not terms:
        return 0.0
    content_norm = _normalize_text(content)
    matched = sum(1 for term in terms if term in content_norm)
    return matched / len(terms)


def _rerank_and_select(query: str, docs: list[KnowledgeDocument], k: int = 4) -> list[KnowledgeDocument]:
    ranked = []
    for doc in docs:
        doc.lexical_overlap = _lexical_overlap(query, doc.content)
        vector_component = doc.score if doc.score is not None else 0.0
        doc.selected_score = vector_component + doc.lexical_overlap
        ranked.append(doc)

    ranked.sort(key=lambda item: item.selected_score, reverse=True)
    selected = [
        doc for doc in ranked[:k]
        if (doc.score is not None and doc.score >= MIN_VECTOR_SCORE) or doc.lexical_overlap >= MIN_LEXICAL_OVERLAP
    ]
    logger.info(
        "RAG top_k_results=%s",
        [
            {
                "id": doc.id,
                "source_table": doc.source_table,
                "similarity_score": doc.score,
                "lexical_overlap": doc.lexical_overlap,
                "selected_score": doc.selected_score,
                "metadata": doc.metadata,
            }
            for doc in ranked[:k]
        ],
    )
    return selected


def _retrieve_from_langchain_bg_embedding(query: str, subject: str, k: int = 8) -> list[KnowledgeDocument]:
    if not db_engine:
        return []

    embedding_query = f"query: {query}"
    query_embedding = embeddings.embed_query(embedding_query)
    params = {
        "embedding": _vector_literal(query_embedding),
        "subject": _subject_key(subject),
        "limit": k,
    }
    logger.info("RAG user_query=%s embedding_query=%s", query, embedding_query)

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
        """,
    ]

    for statement in sql_variants:
        try:
            with db_engine.connect() as conn:
                rows = conn.execute(text(statement), params).fetchall()
            docs = [_row_to_doc(row, "langchain_bg_embedding") for row in rows if getattr(row, "content", None)]
            if docs:
                logger.info(
                    "RAG langchain_bg_embedding_results=%s",
                    [
                        {
                            "id": doc.id,
                            "score": doc.score,
                            "metadata": doc.metadata,
                            "preview": doc.content[:220].replace("\n", " "),
                        }
                        for doc in docs
                    ],
                )
                return docs
        except Exception as exc:
            logger.debug("langchain_bg_embedding query variant failed: %s", exc)
    return []


def _retrieve_from_pgvector_fallback(query: str, subject: str, k: int = 8) -> list[KnowledgeDocument]:
    if not fallback_vector_store:
        return []
    try:
        results = fallback_vector_store.similarity_search_with_score(
            f"query: {query}",
            k=k,
            filter={"subject": _subject_key(subject)},
        )
    except Exception as exc:
        logger.exception("langchain_pg_embedding fallback retrieval failed: %s", exc)
        return []

    docs = []
    for doc, raw_score in results:
        score = None
        try:
            distance = float(raw_score)
            score = 1 - distance if distance <= 2 else distance
        except (TypeError, ValueError):
            pass
        docs.append(
            KnowledgeDocument(
                id=str(doc.metadata.get("id") or doc.metadata.get("source") or ""),
                content=str(doc.page_content or ""),
                metadata=dict(doc.metadata or {}),
                score=score,
                source_table="langchain_pg_embedding",
            )
        )
    logger.info(
        "RAG langchain_pg_embedding_results=%s",
        [
            {
                "id": doc.id,
                "score": doc.score,
                "metadata": doc.metadata,
                "preview": doc.content[:220].replace("\n", " "),
            }
            for doc in docs
        ],
    )
    return docs


def retrieve_knowledge_documents(query: str, subject: str, k: int = 8) -> list[KnowledgeDocument]:
    bg_docs = _retrieve_from_langchain_bg_embedding(query, subject, k)
    selected = _rerank_and_select(query, bg_docs)
    if selected:
        logger.info("RAG selected_context_source=langchain_bg_embedding")
        return selected

    pg_docs = _retrieve_from_pgvector_fallback(query, subject, k)
    selected = _rerank_and_select(query, pg_docs)
    if selected:
        logger.info("RAG selected_context_source=langchain_pg_embedding")
    return selected


def _doc_brief(doc: KnowledgeDocument) -> dict:
    return {
        "id": doc.id,
        "source_table": doc.source_table,
        "score": doc.score,
        "lexical_overlap": doc.lexical_overlap,
        "selected_score": doc.selected_score,
        "metadata": doc.metadata,
    }


def _serialize_context(docs: list[KnowledgeDocument]) -> str:
    parts = []
    total = 0
    for index, doc in enumerate(docs, start=1):
        chunk = (
            f"[DOC {index}]\n"
            f"source_table: {doc.source_table}\n"
            f"id: {doc.id}\n"
            f"score: {doc.score}\n"
            f"metadata: {json.dumps(doc.metadata, ensure_ascii=False)}\n"
            f"content:\n{doc.content.strip()}\n"
        )
        if total + len(chunk) > MAX_SELECTED_CONTEXT_CHARS:
            break
        parts.append(chunk)
        total += len(chunk)
    selected_context = "\n---\n".join(parts)
    logger.info("RAG selected_context=%s", selected_context[:5000])
    return selected_context


@tool
def retrieved_context(query: str, subject: str):
    """Tìm kiếm thông tin thí nghiệm trong langchain_bg_embedding trước, sau đó mới tới langchain_pg_embedding."""
    return _serialize_context(retrieve_knowledge_documents(query, subject, k=8))


prompt = """
Bạn là Trợ lý Phòng thí nghiệm Ảo.

QUY TẮC BẮT BUỘC:
1. Chỉ trả lời dựa trên context retrieve được.
2. Không tự tạo hóa chất, khối lượng, thể tích, nhiệt độ, xúc tác, hiện tượng hoặc bước thực hiện.
3. Nếu context thiếu dữ liệu, ghi "Không có dữ liệu." cho phần thiếu.
4. Nếu không tìm thấy context phù hợp, trả đúng câu: "Không tìm thấy dữ liệu thí nghiệm phù hợp."
5. Không dùng trí nhớ hội thoại để dựng thí nghiệm mới.
"""
agent = create_agent(model, [retrieved_context], system_prompt=prompt)


CHEMICAL_REGISTRY_CACHE: dict[str, dict] = {"chemicals": {}, "loaded": False}


def _chemical_alias_candidates(row_data: dict) -> list[str]:
    values = [
        row_data.get("name_vi"),
        row_data.get("formula"),
        row_data.get("chemical_type"),
        row_data.get("description"),
    ]
    aliases = []
    for value in values:
        if not value:
            continue
        aliases.append(str(value))
        aliases.append(_compact_key(value))

    seen = set()
    deduped = []
    for alias in aliases:
        normalized = _normalize_text(alias)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(alias)
    return deduped


def _build_chemical_record(row_data: dict) -> dict:
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
            *(_compact_key(alias) for alias in record["aliases"]),
        }
        for key in keys:
            if key:
                registry[key] = record

    CHEMICAL_REGISTRY_CACHE.update({"chemicals": registry, "loaded": True})
    logger.info("Loaded %s chemical aliases from chemicals table", len(registry))
    return registry


def _resolve_chemical_from_context(name: str) -> dict:
    registry = _load_chemical_registry()
    key = _compact_key(name)
    if key in registry:
        return registry[key]
    normalized_name = _normalize_text(name)
    for record in registry.values():
        if any(_normalize_text(alias) == normalized_name for alias in record.get("aliases", [])):
            return record
    return {
        "canonical_id": key,
        "id_chemical": None,
        "name_vi": name,
        "name_en": name,
        "formula": None,
        "chemical_type": None,
        "physical_state": None,
        "aliases": [name, key],
    }


def _is_chemistry_subject(selected_subject: str) -> bool:
    subject = _normalize_text(selected_subject or "general")
    return not subject or any(token in subject for token in ["general", "chem", "hoa"])


def _is_experiment_question(question: str) -> bool:
    haystack = _normalize_text(question)
    trigger_words = {
        "thi nghiem", "thuc hien", "dieu che", "phan ung", "nhan biet",
        "ket tua", "hien tuong", "trang guong", "este", "hidro", "hydro",
        "sunfat", "hidroxit", "axit", "bazo",
    }
    return any(word in haystack for word in trigger_words)


def _extract_json_object(raw_text: str) -> dict | None:
    text_value = clean_repeating_text(raw_text or "")
    text_value = re.sub(r"^```(?:json)?\s*", "", text_value.strip(), flags=re.IGNORECASE)
    text_value = re.sub(r"\s*```$", "", text_value.strip())
    try:
        parsed = json.loads(text_value)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    match = re.search(r"\{.*\}", text_value, flags=re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _format_amount(value) -> str:
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return str(value)


def _number_in_context(value, context: str) -> bool:
    if value is None:
        return False
    amount = _format_amount(value)
    variants = {amount, amount.replace(".", ","), f"{float(value):.1f}".rstrip("0").rstrip(".")}
    context_norm = _normalize_text(context)
    return any(_normalize_text(item) in context_norm for item in variants if item)


def _text_in_context(value: str, context: str) -> bool:
    if not value:
        return False
    value_norm = _normalize_text(value)
    context_norm = _normalize_text(context)
    if value_norm and value_norm in context_norm:
        return True
    compact_value = _compact_key(value)
    return bool(compact_value and compact_value in _compact_key(context))


def _unit_in_context(unit: str | None, context: str) -> bool:
    unit_key = _normalize_text(unit)
    context_norm = _normalize_text(context)
    equivalents = {
        "ml": {"ml", "mililit", "m l"},
        "g": {"g", "gam", "gram"},
        "mg": {"mg", "miligam"},
        "giot": {"giot"},
        "°c": {"°c", "do c", "c"},
    }
    variants = equivalents.get(unit_key, {unit_key})
    return any(variant and variant in context_norm for variant in variants)


def _chemical_in_context(name: str, context: str) -> bool:
    if _text_in_context(name, context):
        return True
    record = _resolve_chemical_from_context(name)
    return any(_text_in_context(alias, context) for alias in record.get("aliases", []))


def _normalize_unit(unit: str | None) -> str | None:
    unit_key = _normalize_text(unit)
    if unit_key in {"ml", "mililit"}:
        return "ml"
    if unit_key in {"g", "gam", "gram"}:
        return "g"
    if unit_key == "mg":
        return "mg"
    if unit_key in {"giot", "giọt"}:
        return "giọt"
    if unit_key in {"do c", "c", "°c"}:
        return "°C"
    return unit.strip() if isinstance(unit, str) and unit.strip() else None


def _action_type_from_step(step: dict) -> str:
    action = _normalize_text(step.get("action_type") or step.get("action_description"))
    unit = _normalize_unit(step.get("unit"))
    if "dun" in action or "gia nhiet" in action or "heat" in action:
        return "heat"
    if unit == "g":
        return "add"
    return "pour"


def _strict_extraction_prompt(question: str, selected_context: str) -> str:
    return f"""
Bạn là bộ trích xuất dữ liệu thí nghiệm.

Chỉ được dùng CONTEXT bên dưới. Không dùng kiến thức ngoài context. Không tự thêm hóa chất, lượng, nhiệt độ, xúc tác, hiện tượng hoặc bước thực hiện.
Nếu context không mô tả một thí nghiệm phù hợp với USER_QUERY, trả JSON: {{"found": false, "reason": "Không tìm thấy dữ liệu thí nghiệm phù hợp."}}
Nếu một trường không xuất hiện trong context, điền null hoặc [].
Không bọc markdown. Chỉ trả JSON hợp lệ theo schema:
{{
  "found": true,
  "experiment_id": null,
  "reaction_id": null,
  "experiment_name": "...",
  "tools": ["..."],
  "chemicals": [
    {{"chemical_name_vi": "...", "amount": 0, "unit": "ml|g|mg|giọt", "tolerance": null}}
  ],
  "steps": [
    {{"step_order": 1, "chemical_name_vi": "...", "amount": 0, "unit": "ml|g|mg|giọt", "action_type": "pour|add|heat", "action_description": "...", "heating_required": false, "target_temperature": null}}
  ],
  "conditions": {{"heating_required": false, "target_temperature": null, "catalyst": null, "text": null}},
  "phenomenon": "..."
}}

USER_QUERY:
{question}

CONTEXT:
{selected_context}
""".strip()


def _llm_extract_plan(question: str, selected_context: str) -> tuple[dict | None, str, str]:
    final_prompt = _strict_extraction_prompt(question, selected_context)
    logger.info("RAG final_prompt=%s", final_prompt[:6000])
    try:
        response = model.invoke([HumanMessage(content=final_prompt)])
        raw_response = response.content if hasattr(response, "content") else str(response)
    except Exception as exc:
        logger.exception("RAG strict extraction LLM failed: %s", exc)
        return None, final_prompt, ""
    logger.info("RAG raw_llm_response=%s", raw_response)
    return _extract_json_object(raw_response), final_prompt, raw_response


def _coerce_float(value):
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _validate_extracted_payload(payload: dict | None, selected_context: str) -> dict:
    issues = []
    if not payload or not payload.get("found"):
        return {"ok": False, "issues": ["not_found"]}

    chemicals = payload.get("chemicals") or []
    steps = payload.get("steps") or []
    if not payload.get("experiment_name"):
        issues.append("missing_experiment_name")
    if not chemicals:
        issues.append("missing_chemicals")
    if not steps:
        issues.append("missing_steps")
    if not payload.get("phenomenon"):
        issues.append("missing_phenomenon")

    for chemical in chemicals:
        name = chemical.get("chemical_name_vi")
        amount = _coerce_float(chemical.get("amount"))
        unit = _normalize_unit(chemical.get("unit"))
        if not name or not _chemical_in_context(name, selected_context):
            issues.append(f"chemical_not_in_context:{name}")
        if amount is None or not _number_in_context(amount, selected_context):
            issues.append(f"amount_not_in_context:{name}:{chemical.get('amount')}")
        if not unit or not _unit_in_context(unit, selected_context):
            issues.append(f"unit_not_in_context:{name}:{chemical.get('unit')}")

    for step in steps:
        name = step.get("chemical_name_vi")
        amount = _coerce_float(step.get("amount"))
        unit = _normalize_unit(step.get("unit"))
        if step.get("action_type") == "heat":
            temperature = _coerce_float(step.get("target_temperature"))
            if temperature is not None and not _number_in_context(temperature, selected_context):
                issues.append(f"temperature_not_in_context:{temperature}")
            continue
        if name and not _chemical_in_context(name, selected_context):
            issues.append(f"step_chemical_not_in_context:{name}")
        if amount is not None and not _number_in_context(amount, selected_context):
            issues.append(f"step_amount_not_in_context:{name}:{amount}")
        if unit and not _unit_in_context(unit, selected_context):
            issues.append(f"step_unit_not_in_context:{name}:{unit}")

    result = {"ok": not issues, "issues": issues}
    logger.info("RAG extracted_payload_validation=%s", result)
    return result


def _build_plan_from_payload(payload: dict, docs: list[KnowledgeDocument]) -> dict:
    chemicals = []
    for item in payload.get("chemicals") or []:
        record = _resolve_chemical_from_context(item.get("chemical_name_vi") or "")
        amount = _coerce_float(item.get("amount"))
        unit = _normalize_unit(item.get("unit"))
        tolerance = _coerce_float(item.get("tolerance"))
        chemicals.append({
            "canonical_id": record["canonical_id"],
            "name_vi": record["name_vi"],
            "name_en": record["name_en"],
            "amount": amount,
            "unit": unit,
            "tolerance": tolerance,
            "role": "reactant",
        })

    steps = []
    for index, item in enumerate(payload.get("steps") or [], start=1):
        action_type = _action_type_from_step(item)
        record = _resolve_chemical_from_context(item.get("chemical_name_vi") or "") if action_type != "heat" else None
        amount = _coerce_float(item.get("amount"))
        unit = _normalize_unit(item.get("unit"))
        target_temperature = _coerce_float(item.get("target_temperature"))
        heating_required = bool(item.get("heating_required")) or action_type == "heat"
        steps.append({
            "step_order": int(item.get("step_order") or index),
            "chemical_name_vi": record["name_vi"] if record else None,
            "canonical_id": record["canonical_id"] if record else None,
            "id_chemical": record.get("id_chemical") if record else None,
            "id_tool": None,
            "target_amount": amount,
            "unit": unit,
            "tolerance": None,
            "action_type": action_type,
            "auto_stop": True,
            "heating_required": heating_required,
            "target_temperature": target_temperature,
            "action_description": item.get("action_description") or "",
        })

    conditions = payload.get("conditions") or {}
    heating_required = bool(conditions.get("heating_required")) or any(step["action_type"] == "heat" for step in steps)
    target_temperature = _coerce_float(conditions.get("target_temperature"))
    source_documents = [_doc_brief(doc) for doc in docs]
    experiment_name = payload.get("experiment_name") or "Không có dữ liệu."
    experiment_id = payload.get("experiment_id") or _compact_key(experiment_name)
    reaction_id = payload.get("reaction_id") or None

    plan = {
        "experiment_id": experiment_id,
        "reaction_id": reaction_id,
        "title": experiment_name,
        "steps": steps,
        "required_chemicals": chemicals,
        "required_tools": payload.get("tools") or [],
        "required_conditions": {
            "temperature_min": target_temperature,
            "temperature_max": None,
            "heating_required": heating_required,
            "order_required": True,
            "catalyst": conditions.get("catalyst"),
            "text": conditions.get("text"),
            "steps": [
                {
                    "step": step["step_order"],
                    "action": "heat" if step["action_type"] == "heat" else "add_chemical",
                    "chemical": step["chemical_name_vi"],
                    "canonical_id": step["canonical_id"],
                    "amount": step["target_amount"],
                    "unit": step["unit"],
                    "temperature_min": step["target_temperature"],
                }
                for step in steps
            ],
        },
        "success_reaction_id": reaction_id,
        "success_message": payload.get("phenomenon") or "Không có dữ liệu.",
        "phenomenon": payload.get("phenomenon") or "Không có dữ liệu.",
        "fail_messages": {
            "wrong_chemical": "Bạn đã dùng sai hóa chất.",
            "missing_chemical": "Bạn chưa lấy đủ hóa chất cần thiết.",
            "wrong_amount": "Khối lượng hoặc thể tích chưa đúng.",
            "wrong_order": "Bạn đã thực hiện sai thứ tự thao tác.",
            "wrong_temperature": "Điều kiện nhiệt độ chưa phù hợp.",
            "wrong_reaction": "Phản ứng tạo ra không khớp thí nghiệm đã chọn.",
        },
        "knowledge_source_priority": docs[0].source_table if docs else None,
        "source_documents": source_documents,
    }
    logger.info("RAG generated_experiment_plan=%s", json.dumps(plan, ensure_ascii=False))
    return plan


def _format_tolerance(tolerance, unit: str | None) -> str:
    if tolerance is None:
        return "sai số: Không có dữ liệu"
    return f"sai số ±{_format_amount(tolerance)} {unit or ''}".strip()


def _format_answer_from_plan(plan: dict) -> str:
    chemical_lines = []
    for item in plan.get("required_chemicals", []):
        chemical_lines.append(
            f"* {item.get('name_vi')}: {_format_amount(item.get('amount'))} {item.get('unit')} "
            f"({_format_tolerance(item.get('tolerance'), item.get('unit'))})"
        )

    tool_lines = [f"* {tool}" for tool in plan.get("required_tools", [])] or ["* Không có dữ liệu."]

    step_lines = []
    for step in sorted(plan.get("steps", []), key=lambda value: value.get("step_order") or 0):
        description = step.get("action_description") or "Không có dữ liệu."
        step_lines.append(f"{step.get('step_order')}. {description}")

    conditions = plan.get("required_conditions") or {}
    condition_lines = []
    if conditions.get("heating_required"):
        if conditions.get("temperature_min") is not None:
            condition_lines.append(f"* Đun nóng đến {_format_amount(conditions.get('temperature_min'))}°C.")
        elif conditions.get("text"):
            condition_lines.append(f"* {conditions.get('text')}")
        else:
            condition_lines.append("* Cần đun nóng: Không có dữ liệu nhiệt độ.")
    elif conditions.get("catalyst"):
        condition_lines.append(f"* Xúc tác: {conditions.get('catalyst')}.")
    else:
        condition_lines.append("* Không cần đun nóng hoặc xúc tác đặc biệt.")

    return (
        f"Tên thí nghiệm: {plan.get('title') or 'Không có dữ liệu.'}\n\n"
        "Hóa chất cần dùng:\n\n"
        + "\n".join(chemical_lines or ["* Không có dữ liệu."])
        + "\n\nDụng cụ cần dùng:\n\n"
        + "\n".join(tool_lines)
        + "\n\nThứ tự thực hiện:\n\n"
        + "\n".join(step_lines or ["1. Không có dữ liệu."])
        + "\n\nĐiều kiện:\n\n"
        + "\n".join(condition_lines)
        + "\n\nHiện tượng/phản ứng dự kiến:\n\n"
        + f"* {plan.get('phenomenon') or 'Không có dữ liệu.'}"
    )


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
        if name and _normalize_text(name) not in normalized_answer:
            issues.append(f"answer_text thiếu hóa chất {name}")
        if amount and amount != "None" and amount not in normalized_answer:
            issues.append(f"answer_text thiếu lượng {amount} của {name}")
        if unit and _normalize_text(unit) not in normalized_answer:
            issues.append(f"answer_text thiếu đơn vị {unit} của {name}")
    result = {"ok": not issues, "issues": issues}
    logger.info("RAG consistency answer_text_vs_plan=%s", result)
    return result


def validate_plan_against_documents(plan: dict | None, docs: list[KnowledgeDocument]) -> dict:
    if not plan:
        return {"ok": True, "issues": []}
    context = _serialize_context(docs)
    issues = []
    for chemical in plan.get("required_chemicals", []):
        if not _chemical_in_context(chemical.get("name_vi"), context):
            issues.append(f"document thiếu hóa chất {chemical.get('name_vi')}")
        if not _number_in_context(chemical.get("amount"), context):
            issues.append(f"document thiếu lượng {chemical.get('amount')} của {chemical.get('name_vi')}")
        if not _unit_in_context(chemical.get("unit"), context):
            issues.append(f"document thiếu đơn vị {chemical.get('unit')} của {chemical.get('name_vi')}")
    result = {"ok": not issues, "issues": issues}
    logger.info("RAG consistency plan_vs_retrieved_context=%s", result)
    return result


def build_experiment_plan(
    question: str,
    selected_subject: str = "Chemistry",
    retrieved_docs: list[KnowledgeDocument] | None = None,
):
    if not _is_chemistry_subject(selected_subject) or not _is_experiment_question(question):
        return None, None, {"ok": True, "issues": []}

    docs = retrieved_docs or []
    if not docs:
        return None, None, {"ok": False, "issues": ["no_retrieved_context"]}

    selected_context = _serialize_context(docs)
    payload, _, _ = _llm_extract_plan(question, selected_context)
    validation = _validate_extracted_payload(payload, selected_context)

    if not validation["ok"]:
        logger.info("RAG no valid experiment payload; issues=%s", validation["issues"])
        return None, None, validation

    plan = _build_plan_from_payload(payload, docs)
    answer_text = _format_answer_from_plan(plan)
    return plan, answer_text, validation


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


def ask_questions(question: str, selected_subject: str, history: list = None):
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

    input_messages.append(HumanMessage(content=f"[Môn học: {(selected_subject or 'general').lower()}] {question}"))
    try:
        response = agent.invoke({"messages": input_messages})
        raw_answer = response["messages"][-1].content
        logger.info("RAG raw_llm_response=%s", raw_answer)
        return _extract_answer_text(raw_answer)
    except Exception as exc:
        logger.exception("Error in ask_questions: %s", exc)
        return "Xin lỗi, mình gặp chút trục trặc khi xử lý câu hỏi. Bạn thử lại nhé!"


def ask_questions_with_plan(question: str, selected_subject: str, history: list = None):
    docs = retrieve_knowledge_documents(question, selected_subject, k=8)
    is_experiment_query = _is_chemistry_subject(selected_subject) and _is_experiment_question(question)

    if is_experiment_query:
        plan, answer_text, extraction_validation = build_experiment_plan(
            question,
            selected_subject=selected_subject,
            retrieved_docs=docs,
        )
        if not plan:
            result = {
                "answer_text": NO_EXPERIMENT_DATA_MESSAGE,
                "experiment_plan": None,
                "retrieved_documents": [_doc_brief(doc) for doc in docs],
                "consistency_validation": {
                    "extraction": extraction_validation,
                    "answer_text_vs_plan": {"ok": True, "issues": []},
                    "plan_vs_retrieved_context": {"ok": False, "issues": extraction_validation.get("issues", [])},
                },
                "is_experiment_query": True,
            }
            logger.info("RAG consistency validation result=%s", result["consistency_validation"])
            return result

        validations = {
            "extraction": extraction_validation,
            "answer_text_vs_plan": validate_answer_matches_plan(answer_text, plan),
            "plan_vs_retrieved_context": validate_plan_against_documents(plan, docs),
        }
        logger.info("RAG consistency validation result=%s", validations)
        return {
            "answer_text": answer_text,
            "experiment_plan": plan,
            "retrieved_documents": [_doc_brief(doc) for doc in docs],
            "consistency_validation": validations,
            "is_experiment_query": True,
        }

    answer = ask_questions(question, selected_subject=selected_subject, history=history)
    return {
        "answer_text": answer,
        "experiment_plan": None,
        "retrieved_documents": [_doc_brief(doc) for doc in docs],
        "consistency_validation": {},
        "is_experiment_query": False,
    }
