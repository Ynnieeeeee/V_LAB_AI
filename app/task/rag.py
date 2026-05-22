from dataclasses import dataclass
import concurrent.futures
import json
import logging
from pathlib import Path
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
MIN_VECTOR_SCORE = 0.08
MIN_LEXICAL_OVERLAP = 0.05
MIN_SPECIFIC_OVERLAP = 0.34
MIN_REACTION_FUZZY_SCORE = 2.2
MAX_SELECTED_CONTEXT_CHARS = 12000
RAG_RETRIEVAL_TIMEOUT_SECONDS = 12
RAG_EXTRACTION_TIMEOUT_SECONDS = 25
RAG_GENERAL_TIMEOUT_SECONDS = 25
REACTION_DATABASE_PATH = Path(__file__).resolve().parents[1] / "src" / "assets" / "threejs" / "ReactionDatabase.js"
_RAG_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="mascot-rag")

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
    specific_overlap: float = 0.0
    signal_overlap: float = 0.0
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


def _run_with_timeout(label: str, timeout_seconds: float, default, func, *args, **kwargs):
    future = _RAG_EXECUTOR.submit(func, *args, **kwargs)
    try:
        return future.result(timeout=timeout_seconds)
    except concurrent.futures.TimeoutError:
        future.cancel()
        logger.error("[MascotRAG] %s timed out after %ss", label, timeout_seconds)
        return default
    except Exception as exc:
        logger.exception("[MascotRAG] %s failed: %s", label, exc)
        return default


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
    "khong", "co", "du", "lieu", "lien", "quan", "bat", "ky", "mot", "ve",
    "toi", "muon", "can", "xin", "thu", "tinh", "khi", "cua", "cac", "bang",
    "tieng", "viet", "hay", "cho", "biet", "tao", "ra", "tu", "va",
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


def _specific_query_terms(query: str) -> set[str]:
    terms = _query_terms(query)
    normalized_query = _normalize_text(query)
    compact_query = _compact_key(query)
    formula_terms = set(re.findall(r"[a-z]{1,3}\d[a-z0-9]*", normalized_query))
    important = {
        term for term in terms
        if term in formula_terms
        or len(term) >= 4
        or term in {"h2", "o2", "co2", "cl2", "nh3", "hcl", "naoh", "agno3", "c2h4"}
    }

    if {"ethylene", "ethene", "etilen", "etylen", "c2h4"} & terms or "c2h4" in compact_query:
        important.update({"ethylene", "ethene", "etilen", "etylen", "c2h4"})
    if "trang bac" in normalized_query or "trang guong" in normalized_query or "tollens" in normalized_query:
        important.update({"trang", "bac", "guong", "tollens", "agno3"})
    return {term for term in important if term and term not in STOPWORDS}


def _specific_overlap(query: str, content: str) -> float:
    terms = _specific_query_terms(query)
    if not terms:
        return 0.0
    content_norm = _normalize_text(content)
    content_compact = _compact_key(content)
    matched = 0
    for term in terms:
        term_compact = _compact_key(term)
        if term in content_norm or (term_compact and term_compact in content_compact):
            matched += 1
    return matched / len(terms)


def _query_signal_groups(query: str) -> list[set[str]]:
    normalized_query = _normalize_text(query)
    groups: list[set[str]] = []

    if re.search(r"\bc2h4\b", normalized_query) or any(term in normalized_query for term in ["ethylene", "ethene", "etilen", "etylen"]):
        groups.append({"c2h4", "ethylene", "ethene", "etilen", "etylen"})

    if "trang bac" in normalized_query or "trang guong" in normalized_query or "tollens" in normalized_query:
        groups.append({"trang bac", "trang guong", "tollens", "agno3", "bac nitrat"})

    formula_terms = set(re.findall(r"\b[a-z]{1,3}\d[a-z0-9]*\b", normalized_query))
    for formula in formula_terms:
        if formula not in {"c2h4"}:
            groups.append({formula})

    return groups


def _signal_overlap(query: str, content: str) -> float:
    groups = _query_signal_groups(query)
    if not groups:
        return 0.0
    content_norm = _normalize_text(content)
    content_compact = _compact_key(content)
    matched = 0
    for group in groups:
        if any(term in content_norm or _compact_key(term) in content_compact for term in group):
            matched += 1
    return matched / len(groups)


def _rerank_and_select(query: str, docs: list[KnowledgeDocument], k: int = 4) -> list[KnowledgeDocument]:
    ranked = []
    specific_terms = _specific_query_terms(query)
    signal_groups = _query_signal_groups(query)
    for doc in docs:
        doc.lexical_overlap = _lexical_overlap(query, doc.content)
        doc.specific_overlap = _specific_overlap(query, doc.content)
        doc.signal_overlap = _signal_overlap(query, doc.content)
        vector_component = doc.score if doc.score is not None else 0.0
        doc.selected_score = vector_component + doc.lexical_overlap + (doc.specific_overlap * 2) + (doc.signal_overlap * 2)
        ranked.append(doc)

    ranked.sort(key=lambda item: item.selected_score, reverse=True)

    def relevant(doc: KnowledgeDocument) -> bool:
        has_generic_match = (
            (doc.score is not None and doc.score >= MIN_VECTOR_SCORE)
            or doc.lexical_overlap >= MIN_LEXICAL_OVERLAP
        )
        if not has_generic_match:
            return False
        if signal_groups and doc.signal_overlap <= 0 and doc.specific_overlap < MIN_SPECIFIC_OVERLAP:
            return False
        if specific_terms and doc.specific_overlap < MIN_SPECIFIC_OVERLAP and doc.signal_overlap <= 0:
            return False
        return True

    selected = [
        doc for doc in ranked[:k]
        if relevant(doc)
    ]
    if (
        not selected
        and ranked
        and not specific_terms
        and not signal_groups
        and ranked[0].selected_score > 0
        and ranked[0].lexical_overlap > 0
    ):
        selected = [ranked[0]]
    logger.info(
        "RAG top_k_results=%s",
        [
            {
                "id": doc.id,
                "source_table": doc.source_table,
                "similarity_score": doc.score,
                "lexical_overlap": doc.lexical_overlap,
                "specific_overlap": doc.specific_overlap,
                "signal_overlap": doc.signal_overlap,
                "selected_score": doc.selected_score,
                "metadata": doc.metadata,
            }
            for doc in ranked[:k]
        ],
    )
    logger.info(
        "[MascotRAG] top_k results: %s",
        [
            {
                "id": doc.id,
                "source_table": doc.source_table,
                "similarity_score": doc.score,
                "lexical_overlap": doc.lexical_overlap,
                "specific_overlap": doc.specific_overlap,
                "signal_overlap": doc.signal_overlap,
                "selected_score": doc.selected_score,
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
    logger.info("[MascotRAG] user query: %s", query)

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
                logger.info(
                    "[MascotRAG] bg embedding results: %s",
                    [
                        {
                            "id": doc.id,
                            "similarity_score": doc.score,
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
        search_query = f"query: {query}"
        subject_filter = {"subject": _subject_key(subject)}
        results = fallback_vector_store.similarity_search_with_score(
            search_query,
            k=k,
            filter=subject_filter,
        )
        if not results:
            logger.info(
                "[MascotRAG] langchain_pg_embedding no results with filter=%s; retrying without metadata filter",
                subject_filter,
            )
            results = fallback_vector_store.similarity_search_with_score(search_query, k=k)
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
        logger.info("[MascotRAG] bg selected: %s", [_doc_brief(doc) for doc in selected])
        return selected
    logger.info("[MascotRAG] bg selected: none")
    logger.info("[MascotRAG] trying langchain_pg_embedding fallback")

    pg_docs = _retrieve_from_pgvector_fallback(query, subject, k)
    selected = _rerank_and_select(query, pg_docs)
    if selected:
        logger.info("RAG selected_context_source=langchain_pg_embedding")
        logger.info("[MascotRAG] pg selected: %s", [_doc_brief(doc) for doc in selected])
        return selected

    logger.info("[MascotRAG] pg selected: none")
    return []


def retrieve_knowledge_documents_safe(query: str, subject: str, k: int = 8) -> list[KnowledgeDocument]:
    return _run_with_timeout(
        "retrieval",
        RAG_RETRIEVAL_TIMEOUT_SECONDS,
        [],
        retrieve_knowledge_documents,
        query,
        subject,
        k,
    )


def _doc_brief(doc: KnowledgeDocument) -> dict:
    return {
        "id": doc.id,
        "source_table": doc.source_table,
        "score": doc.score,
        "lexical_overlap": doc.lexical_overlap,
        "specific_overlap": doc.specific_overlap,
        "signal_overlap": doc.signal_overlap,
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
    logger.info("[MascotRAG] selected context: %s", selected_context[:5000])
    return selected_context


@tool
def retrieved_context(query: str, subject: str):
    """Tìm kiếm thông tin thí nghiệm trong langchain_bg_embedding, rồi fallback sang langchain_pg_embedding."""
    return _serialize_context(retrieve_knowledge_documents_safe(query, subject, k=8))


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
REACTION_DATABASE_CACHE: dict[str, object] = {
    "rules": None,
    "rules_mtime": None,
    "aliases": None,
    "aliases_mtime": None,
}

REACTION_RULE_METADATA: dict[str, dict] = {
    "silver_mirror_from_tollens_glucose_heat": {
        "name": "Phản ứng tráng bạc",
        "aliases": [
            "phản ứng tráng bạc",
            "tráng bạc",
            "tráng gương",
            "gương bạc",
            "Tollens",
            "thuốc thử Tollens",
            "bạc amoniac",
            "silver mirror",
        ],
        "keywords": [
            "AgNO3",
            "NH3",
            "aldehyde",
            "andehit",
            "glucose",
            "glucozơ",
            "[Ag(NH3)2]OH",
            "bạc amoniac",
        ],
        "phenomenon": "Xuất hiện lớp bạc sáng bám trên thành ống nghiệm.",
    },
    "ba_cl2_h2so4": {
        "name": "Phản ứng Bari Clorua và Axit Sunfuric",
        "aliases": [
            "bari clorua axit sunfuric",
            "BaCl2 H2SO4",
            "bari sunfat",
            "BaSO4",
        ],
        "keywords": ["BaCl2", "H2SO4", "BaSO4", "kết tủa trắng"],
        "phenomenon": "Xuất hiện kết tủa trắng đặc Bari Sunfat.",
    },
    "cu_so4_naoh": {
        "name": "Phản ứng Đồng(II) Sunfat và Natri Hydroxit",
        "aliases": [
            "đồng sunfat natri hidroxit",
            "đồng sunfat natri hydroxit",
            "Đồng(II) Sunfat Natri Hydroxit",
            "CuSO4 NaOH",
            "đồng hidroxit",
            "đồng hydroxit",
        ],
        "keywords": ["CuSO4", "NaOH", "Cu(OH)2", "kết tủa xanh"],
        "phenomenon": "Xuất hiện kết tủa xanh lam keo Đồng Hydroxit.",
    },
}


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
    logger.info("[MascotRAG] final prompt: %s", final_prompt[:6000])
    try:
        response = model.invoke([HumanMessage(content=final_prompt)])
        raw_response = response.content if hasattr(response, "content") else str(response)
    except Exception as exc:
        logger.exception("RAG strict extraction LLM failed: %s", exc)
        return None, final_prompt, ""
    logger.info("RAG raw_llm_response=%s", raw_response)
    logger.info("[MascotRAG] raw llm response: %s", raw_response)
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
    if not chemicals and not steps and not payload.get("phenomenon"):
        issues.append("missing_experiment_data")

    for chemical in chemicals:
        name = chemical.get("chemical_name_vi")
        amount = _coerce_float(chemical.get("amount"))
        unit = _normalize_unit(chemical.get("unit"))
        if not name or not _chemical_in_context(name, selected_context):
            issues.append(f"chemical_not_in_context:{name}")
        if amount is not None and not _number_in_context(amount, selected_context):
            issues.append(f"amount_not_in_context:{name}:{chemical.get('amount')}")
        if unit and not _unit_in_context(unit, selected_context):
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

    conditions = payload.get("conditions") or {}
    catalyst = conditions.get("catalyst")
    if catalyst and not _chemical_in_context(catalyst, selected_context):
        issues.append(f"catalyst_not_in_context:{catalyst}")
    target_temperature = _coerce_float(conditions.get("target_temperature"))
    if target_temperature is not None and not _number_in_context(target_temperature, selected_context):
        issues.append(f"temperature_not_in_context:{target_temperature}")

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
        tolerance = _coerce_float(item.get("tolerance"))
        steps.append({
            "step_order": int(item.get("step_order") or index),
            "chemical_name_vi": record["name_vi"] if record else None,
            "canonical_id": record["canonical_id"] if record else None,
            "id_chemical": record.get("id_chemical") if record else None,
            "id_tool": None,
            "target_amount": amount,
            "unit": unit,
            "tolerance": tolerance,
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


def _missing_quantity_text(plan: dict) -> str:
    if plan.get("knowledge_source_priority") == "ReactionDatabase.js":
        return "Không có dữ liệu định lượng trong cơ sở dữ liệu."
    return "Không có dữ liệu định lượng."


def _format_chemical_line(item: dict, plan: dict) -> str:
    name = item.get("name_vi") or item.get("chemical_name_vi") or "Không có dữ liệu"
    amount = item.get("amount")
    unit = item.get("unit")
    if amount is None or not unit:
        return f"* {name}: {_missing_quantity_text(plan)}"
    return (
        f"* {name}: {_format_amount(amount)} {unit} "
        f"({_format_tolerance(item.get('tolerance'), unit)})"
    )


def _format_step_description(step: dict, plan: dict) -> str:
    description = (step.get("action_description") or "").strip()
    if description:
        return description

    if step.get("action_type") == "heat":
        temperature = step.get("target_temperature")
        if temperature is not None:
            return f"Đun nóng đến {_format_amount(temperature)}°C."
        return "Đun nóng. Không có dữ liệu nhiệt độ."

    name = step.get("chemical_name_vi") or "hóa chất"
    amount = step.get("target_amount")
    unit = step.get("unit")
    verb = "Rót" if step.get("action_type") == "pour" else "Thêm"
    if amount is None or not unit:
        return f"{verb} {name}. {_missing_quantity_text(plan)}"
    return f"{verb} {_format_amount(amount)} {unit} {name}."


def _format_answer_from_plan(plan: dict) -> str:
    chemical_lines = [_format_chemical_line(item, plan) for item in plan.get("required_chemicals", [])]

    tool_lines = [f"* {tool}" for tool in plan.get("required_tools", [])] or ["* Không có dữ liệu."]

    step_lines = []
    for step in sorted(plan.get("steps", []), key=lambda value: value.get("step_order") or 0):
        step_lines.append(f"{step.get('step_order')}. {_format_step_description(step, plan)}")

    conditions = plan.get("required_conditions") or {}
    condition_lines = []
    if conditions.get("heating_required"):
        if conditions.get("temperature_min") is not None:
            condition_lines.append(f"* Đun nóng đến {_format_amount(conditions.get('temperature_min'))}°C.")
        elif conditions.get("text"):
            condition_lines.append(f"* {conditions.get('text')}")
        else:
            condition_lines.append("* Cần đun nóng: Không có dữ liệu nhiệt độ.")
    if conditions.get("catalyst"):
        condition_lines.append(f"* Xúc tác: {conditions.get('catalyst')}.")
    if not condition_lines:
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
        if chemical.get("amount") is not None and not _number_in_context(chemical.get("amount"), context):
            issues.append(f"document thiếu lượng {chemical.get('amount')} của {chemical.get('name_vi')}")
        if chemical.get("unit") and not _unit_in_context(chemical.get("unit"), context):
            issues.append(f"document thiếu đơn vị {chemical.get('unit')} của {chemical.get('name_vi')}")
    result = {"ok": not issues, "issues": issues}
    logger.info("RAG consistency plan_vs_retrieved_context=%s", result)
    return result


def _plan_search_text(plan: dict | None) -> str:
    if not plan:
        return ""
    values = [
        plan.get("experiment_id"),
        plan.get("reaction_id"),
        plan.get("success_reaction_id"),
        plan.get("title"),
        plan.get("phenomenon"),
        plan.get("success_message"),
        *(plan.get("required_tools") or []),
    ]
    for chemical in plan.get("required_chemicals") or []:
        values.extend([
            chemical.get("name_vi"),
            chemical.get("name_en"),
            chemical.get("canonical_id"),
        ])
    for step in plan.get("steps") or []:
        values.extend([
            step.get("chemical_name_vi"),
            step.get("canonical_id"),
            step.get("action_description"),
        ])
    return " ".join(str(value) for value in values if value)


def validate_plan_matches_query(plan: dict | None, query: str) -> dict:
    if not plan:
        return {"ok": True, "issues": []}
    specific_terms = _specific_query_terms(query)
    signal_groups = _query_signal_groups(query)
    if not specific_terms and not signal_groups:
        return {"ok": True, "issues": []}

    plan_text = _plan_search_text(plan)
    specific = _specific_overlap(query, plan_text)
    signal = _signal_overlap(query, plan_text)
    issues = []
    if signal_groups and signal <= 0 and specific < MIN_SPECIFIC_OVERLAP:
        issues.append(
            f"plan không khớp tín hiệu câu hỏi: signal_overlap={signal:.2f}, specific_overlap={specific:.2f}"
        )
    if specific_terms and specific < MIN_SPECIFIC_OVERLAP and signal <= 0:
        issues.append(
            f"plan thiếu từ khóa đặc trưng của câu hỏi: {sorted(specific_terms)}"
        )
    result = {
        "ok": not issues,
        "issues": issues,
        "specific_overlap": specific,
        "signal_overlap": signal,
    }
    logger.info("RAG consistency plan_vs_user_query=%s", result)
    return result


def _find_balanced_end(source: str, start: int, open_char: str, close_char: str) -> int:
    depth = 0
    quote = None
    escaped = False
    for index in range(start, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {"'", '"', "`"}:
            quote = char
            continue
        if char == open_char:
            depth += 1
        elif char == close_char:
            depth -= 1
            if depth == 0:
                return index
    return -1


def _extract_balanced_source(source: str, start: int, open_char: str, close_char: str) -> str | None:
    if start < 0 or start >= len(source) or source[start] != open_char:
        return None
    end = _find_balanced_end(source, start, open_char, close_char)
    if end < 0:
        return None
    return source[start:end + 1]


def _js_unquote(value: str) -> str:
    return value.replace("\\'", "'").replace('\\"', '"').replace("\\n", "\n").strip()


def _js_string_literals(source: str) -> list[str]:
    matches = re.findall(r"'((?:\\'|[^'])*)'|\"((?:\\\"|[^\"])*)\"", source or "")
    return [_js_unquote(single or double) for single, double in matches if (single or double)]


def _js_string_field(source: str, field_name: str) -> str | None:
    match = re.search(rf"\b{re.escape(field_name)}\s*:\s*('(?:\\'|[^'])*'|\"(?:\\\"|[^\"])*\")", source or "")
    if not match:
        return None
    values = _js_string_literals(match.group(1))
    return values[0] if values else None


def _js_number_field(source: str, field_name: str) -> float | None:
    match = re.search(rf"\b{re.escape(field_name)}\s*:\s*(-?\d+(?:\.\d+)?)", source or "")
    return _coerce_float(match.group(1)) if match else None


def _js_array_field(source: str, field_name: str) -> list[str]:
    match = re.search(rf"\b{re.escape(field_name)}\s*:\s*\[", source or "")
    if not match:
        return []
    array_source = _extract_balanced_source(source, match.end() - 1, "[", "]")
    return _js_string_literals(array_source or "")


def _js_object_field(source: str, field_name: str) -> str | None:
    match = re.search(rf"\b{re.escape(field_name)}\s*:\s*\{{", source or "")
    if not match:
        return None
    return _extract_balanced_source(source, match.end() - 1, "{", "}")


def _parse_reaction_result(rule_source: str) -> dict:
    match = re.search(r"\bresult\s*:\s*result\s*\(", rule_source or "")
    if not match:
        return {}
    brace_index = rule_source.find("{", match.end())
    result_source = _extract_balanced_source(rule_source, brace_index, "{", "}") or ""
    effect_types = re.findall(r"effect\s*\(\s*['\"]([^'\"]+)['\"]", rule_source or "")
    return {
        "source": result_source,
        "mascotText": _js_string_field(result_source, "mascotText"),
        "equation": _js_string_field(result_source, "equation"),
        "result_chemical_id": _js_string_field(result_source, "result_chemical_id"),
        "result_chemical_type": _js_string_field(result_source, "result_chemical_type"),
        "effect_types": effect_types,
        "precipitate": "precipitate: true" in result_source or "precipitate" in effect_types,
        "gas": "gas:" in result_source or "gas" in effect_types,
        "heat": "heat:" in result_source or "heat" in effect_types,
        "smoke": "smoke:" in result_source or "smoke" in effect_types,
        "color_change": "colorChange" in effect_types or "decolorize" in effect_types,
    }


def _parse_reaction_rule(rule_source: str) -> dict | None:
    reaction_id = _js_string_field(rule_source, "id")
    if not reaction_id:
        return None
    conditions_source = _js_object_field(rule_source, "conditions") or ""
    result_data = _parse_reaction_result(rule_source)
    metadata = REACTION_RULE_METADATA.get(reaction_id, {})
    return {
        "id": reaction_id,
        "name": _js_string_field(rule_source, "name") or metadata.get("name"),
        "aliases": _dedupe_names([*_js_array_field(rule_source, "aliases"), *(metadata.get("aliases") or [])]),
        "keywords": _dedupe_names([*_js_array_field(rule_source, "keywords"), *(metadata.get("keywords") or [])]),
        "priority": _js_number_field(rule_source, "priority") or 0,
        "reactants": _js_array_field(rule_source, "reactants"),
        "requiredExistingSpecies": _js_array_field(rule_source, "requiredExistingSpecies"),
        "products": _js_array_field(rule_source, "products"),
        "phenomenon": _js_string_field(rule_source, "phenomenon") or metadata.get("phenomenon"),
        "conditions": {
            "minTemperature": _js_number_field(conditions_source, "minTemperature"),
            "maxTemperature": _js_number_field(conditions_source, "maxTemperature"),
            "catalyst": _js_string_field(conditions_source, "catalyst"),
            "environment": _js_string_field(conditions_source, "environment"),
            "notEnvironment": _js_string_field(conditions_source, "notEnvironment"),
            "proximity": _js_number_field(conditions_source, "proximity"),
        },
        "result": result_data,
        "source_snippet": rule_source[:1200],
    }


def _extract_reaction_rule_sources(source: str) -> list[str]:
    marker = "LOCAL_REACTION_RULES"
    marker_index = source.find(marker)
    if marker_index < 0:
        return []
    array_start = source.find("[", marker_index)
    array_source = _extract_balanced_source(source, array_start, "[", "]") or ""
    rule_sources = []
    index = 0
    while index < len(array_source):
        if array_source[index] != "{":
            index += 1
            continue
        rule_source = _extract_balanced_source(array_source, index, "{", "}")
        if not rule_source:
            index += 1
            continue
        if re.search(r"\bid\s*:\s*['\"]", rule_source):
            rule_sources.append(rule_source)
        index += len(rule_source)
    return rule_sources


def _parse_reaction_database_rules() -> list[dict]:
    cached = REACTION_DATABASE_CACHE.get("rules")
    try:
        mtime = REACTION_DATABASE_PATH.stat().st_mtime
    except Exception:
        mtime = None
    if cached is not None and REACTION_DATABASE_CACHE.get("rules_mtime") == mtime:
        return cached
    try:
        source = REACTION_DATABASE_PATH.read_text(encoding="utf-8")
    except Exception as exc:
        logger.exception("[MascotFallback] cannot read ReactionDatabase.js: %s", exc)
        return []

    rules = []
    for rule_source in _extract_reaction_rule_sources(source):
        rule = _parse_reaction_rule(rule_source)
        if rule and rule.get("reactants"):
            rules.append(rule)
    REACTION_DATABASE_CACHE["rules"] = rules
    REACTION_DATABASE_CACHE["rules_mtime"] = mtime
    return rules


def _parse_reaction_database_aliases() -> dict[str, set[str]]:
    cached = REACTION_DATABASE_CACHE.get("aliases")
    try:
        mtime = REACTION_DATABASE_PATH.stat().st_mtime
    except Exception:
        mtime = None
    if cached is not None and REACTION_DATABASE_CACHE.get("aliases_mtime") == mtime:
        return cached
    try:
        source = REACTION_DATABASE_PATH.read_text(encoding="utf-8")
    except Exception:
        return {}

    aliases_by_canonical: dict[str, set[str]] = {}
    canonical_match = re.search(r"const\s+CANONICAL\s*=\s*new\s+Map\s*\(\s*\[", source)
    if not canonical_match:
        return aliases_by_canonical
    array_source = _extract_balanced_source(source, canonical_match.end() - 1, "[", "]") or ""
    for alias, canonical in re.findall(r"\[\s*'((?:\\'|[^'])*)'\s*,\s*'((?:\\'|[^'])*)'\s*\]", array_source):
        alias = _js_unquote(alias)
        canonical = _js_unquote(canonical)
        key = _compact_key(canonical)
        if not key:
            continue
        aliases_by_canonical.setdefault(key, set()).update({alias, canonical})
    REACTION_DATABASE_CACHE["aliases"] = aliases_by_canonical
    REACTION_DATABASE_CACHE["aliases_mtime"] = mtime
    return aliases_by_canonical


def _reaction_name_aliases(name: str) -> set[str]:
    aliases = {name}
    alias_map = _parse_reaction_database_aliases()
    key = _compact_key(name)
    aliases.update(alias_map.get(key, set()))

    record = _resolve_chemical_from_context(name)
    aliases.update(record.get("aliases") or [])
    if record.get("formula"):
        aliases.add(record["formula"])
    return {alias for alias in aliases if alias}


def _reaction_alternatives(spec: str) -> list[str]:
    return [part.strip() for part in str(spec or "").split("|") if part.strip()]


def _choose_reaction_alternative(spec: str, query: str) -> str | None:
    alternatives = _reaction_alternatives(spec)
    if not alternatives:
        return None
    query_norm = _normalize_text(query)
    query_compact = _compact_key(query)
    query_terms = _reaction_query_terms(query)
    for option in alternatives:
        for alias in _reaction_name_aliases(option):
            if _reaction_alias_matches_query(alias, query_norm, query_compact, query_terms):
                return option
    return alternatives[0]


def _search_tokens(value: str) -> set[str]:
    tokens = set(re.findall(r"[a-z0-9]{2,}", _normalize_text(value)))
    return {token for token in tokens if token not in STOPWORDS and token not in {"ii", "iii", "iv"}}


def _reaction_alias_matches_query(alias: str, query_norm: str, query_compact: str, query_terms: set[str]) -> bool:
    alias_norm = _normalize_text(alias)
    alias_compact = _compact_key(alias)
    if alias_norm and alias_norm in query_norm:
        return True
    if alias_compact and alias_compact in query_compact:
        return True
    alias_terms = _search_tokens(alias)
    return bool(alias_terms) and alias_terms.issubset(query_terms)


def _reaction_spec_matches_query(spec: str, query: str) -> bool:
    query_norm = _normalize_text(query)
    query_compact = _compact_key(query)
    query_terms = _reaction_query_terms(query)
    for option in _reaction_alternatives(spec):
        for alias in _reaction_name_aliases(option):
            if _reaction_alias_matches_query(alias, query_norm, query_compact, query_terms):
                return True
    return False


def _reaction_query_terms(query: str) -> set[str]:
    terms = set(_query_terms(query))
    normalized_query = _normalize_text(query)
    normalized_tokens = _search_tokens(query)
    for aliases in _parse_reaction_database_aliases().values():
        normalized_aliases = {_normalize_text(alias) for alias in aliases}
        if any(alias and alias in normalized_query for alias in normalized_aliases):
            terms.update(term for alias in aliases for term in _search_tokens(alias))
    if normalized_tokens & {"hidro", "hydro", "hydrogen", "h2"}:
        terms.update({"hidro", "hydro", "hydrogen", "h2"})
    if "ket tua" in normalized_query:
        terms.add("precipitate")
    return {term for term in terms if term and term not in STOPWORDS}


def _reaction_search_text(rule: dict) -> str:
    values = [
        rule.get("id", "").replace("_", " "),
        rule.get("name") or "",
        *(rule.get("aliases") or []),
        *(rule.get("keywords") or []),
        rule.get("phenomenon") or "",
        *rule.get("reactants", []),
        *rule.get("requiredExistingSpecies", []),
        *rule.get("products", []),
        rule.get("result", {}).get("mascotText") or "",
        rule.get("result", {}).get("equation") or "",
        " ".join(rule.get("result", {}).get("effect_types") or []),
    ]
    for spec in [*rule.get("reactants", []), *rule.get("requiredExistingSpecies", []), *rule.get("products", [])]:
        for name in _reaction_alternatives(spec):
            values.extend(_reaction_name_aliases(name))
    return " ".join(str(value) for value in values if value)


def _score_reaction_match(rule: dict, query: str) -> float:
    query_terms = _reaction_query_terms(query)
    if not query_terms:
        return 0.0

    search_text = _normalize_text(_reaction_search_text(rule))
    search_compact = _compact_key(search_text)
    specific_terms = _specific_query_terms(query)
    signal_groups = _query_signal_groups(query)
    if specific_terms or signal_groups:
        specific_match = _specific_overlap(query, search_text)
        signal_match = _signal_overlap(query, search_text)
        if specific_match < MIN_SPECIFIC_OVERLAP and signal_match <= 0:
            return 0.0

    score = 0.0

    for term in query_terms:
        if len(term) <= 2:
            if re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", search_text):
                score += 1.0
        elif term in search_text or _compact_key(term) in search_compact:
            score += 1.0

    for spec in rule.get("reactants", []):
        if _reaction_spec_matches_query(spec, query):
            score += 3.0

    for spec in rule.get("requiredExistingSpecies", []):
        if _reaction_spec_matches_query(spec, query):
            score += 2.0

    for product in rule.get("products", []):
        if _reaction_spec_matches_query(product, query):
            score += 1.5

    query_norm = _normalize_text(query)
    if "nhan biet" in query_norm and rule.get("result", {}).get("precipitate"):
        score += 2.0
    if "ket tua" in query_norm and rule.get("result", {}).get("precipitate"):
        score += 2.0
    if any(term in query_terms for term in {"hidro", "hydro", "hydrogen", "h2", "co2", "o2", "cl2", "nh3", "so2", "no2"}) and rule.get("result", {}).get("gas"):
        score += 1.0

    priority = float(rule.get("priority") or 0)
    return score + min(priority, 150) / 1000.0


def _field_exact_matches_query(value: str, query_norm: str, query_compact: str) -> bool:
    value_norm = _normalize_text(value)
    value_compact = _compact_key(value)
    if not value_norm or value_norm in STOPWORDS:
        return False
    tokens = _search_tokens(value_norm)
    is_formula = bool(re.fullmatch(r"[a-z]{1,3}\d[a-z0-9]*", value_norm))
    is_distinct_phrase = len(tokens) >= 2 or len(value_norm) >= 7 or is_formula
    if not is_distinct_phrase:
        return False
    if is_formula:
        return bool(re.search(rf"(?<![a-z0-9]){re.escape(value_norm)}(?![a-z0-9])", query_norm))
    return value_norm in query_norm or (value_compact and value_compact in query_compact)


def _reaction_exact_keyword_match(rule: dict, query: str) -> tuple[bool, list[str]]:
    query_norm = _normalize_text(query)
    query_compact = _compact_key(query)
    reasons: list[str] = []

    for field_name in ["name", "phenomenon"]:
        value = rule.get(field_name)
        if value and _field_exact_matches_query(value, query_norm, query_compact):
            reasons.append(f"{field_name}:{value}")

    for field_name in ["aliases", "keywords"]:
        for value in rule.get(field_name) or []:
            if _field_exact_matches_query(value, query_norm, query_compact):
                reasons.append(f"{field_name}:{value}")

    chemical_matches = []
    chemical_specs = [
        *rule.get("reactants", []),
        *rule.get("requiredExistingSpecies", []),
        *rule.get("products", []),
    ]
    query_terms = _reaction_query_terms(query)
    for spec in chemical_specs:
        for option in _reaction_alternatives(spec):
            aliases = _reaction_name_aliases(option)
            if any(_reaction_alias_matches_query(alias, query_norm, query_compact, query_terms) for alias in aliases):
                chemical_matches.append(option)
                break

    unique_chemical_matches = _dedupe_names(chemical_matches)
    if len(unique_chemical_matches) >= 2:
        reasons.append("chemicals:" + ", ".join(unique_chemical_matches))

    return bool(reasons), reasons


def search_reaction_database(question: str) -> dict | None:
    logger.info("[MascotFallback] searching ReactionDatabase.js")
    logger.info("[MascotSearch] query: %s", question)
    normalized_query = _normalize_text(question)
    logger.info("[MascotSearch] normalized query: %s", normalized_query)

    exact_matches = []
    fuzzy_scores = []
    for rule in _parse_reaction_database_rules():
        score = _score_reaction_match(rule, question)
        has_exact, exact_reasons = _reaction_exact_keyword_match(rule, question)
        fuzzy_scores.append((score, rule, exact_reasons))
        if has_exact:
            exact_matches.append((score, rule, exact_reasons))

    logger.info(
        "[MascotSearch] exact keyword matches: %s",
        [
            {
                "id": rule.get("id"),
                "name": rule.get("name"),
                "score": score,
                "reasons": reasons,
            }
            for score, rule, reasons in exact_matches
        ],
    )

    if exact_matches:
        exact_matches.sort(key=lambda item: item[0], reverse=True)
        matched_score, matched, reasons = exact_matches[0]
        logger.info(
            "[MascotSearch] fuzzy scores: %s",
            [
                {"id": rule.get("id"), "name": rule.get("name"), "score": score}
                for score, rule, _ in sorted(fuzzy_scores, key=lambda item: item[0], reverse=True)[:8]
            ],
        )
        logger.info("[MascotSearch] selected reaction: %s", matched.get("name") or matched.get("id"))
        logger.info("[MascotSearch] selected reason: exact_keyword:%s", reasons)
        logger.info(
            "[MascotFallback] matched reaction: %s",
            {
                "id": matched.get("id"),
                "name": matched.get("name"),
                "score": matched_score,
                "reactants": matched.get("reactants"),
                "products": matched.get("products"),
            },
        )
        return matched

    candidates = [(score, rule) for score, rule, _ in fuzzy_scores if score > 0]
    candidates.sort(key=lambda item: item[0], reverse=True)
    logger.info(
        "[MascotSearch] fuzzy scores: %s",
        [
            {"id": rule.get("id"), "name": rule.get("name"), "score": score}
            for score, rule in candidates[:8]
        ],
    )
    logger.info(
        "[MascotFallback] ReactionDatabase candidates: %s",
        [
            {
                "id": rule.get("id"),
                "name": rule.get("name"),
                "score": score,
                "reactants": rule.get("reactants"),
                "products": rule.get("products"),
                "mascotText": rule.get("result", {}).get("mascotText"),
            }
            for score, rule in candidates[:8]
        ],
    )
    if not candidates or candidates[0][0] < MIN_REACTION_FUZZY_SCORE:
        logger.info("[MascotSearch] selected reaction: None")
        logger.info("[MascotSearch] selected reason: fuzzy_below_threshold")
        logger.info("[MascotFallback] matched reaction: none")
        return None
    matched = candidates[0][1]
    logger.info("[MascotSearch] selected reaction: %s", matched.get("name") or matched.get("id"))
    logger.info("[MascotSearch] selected reason: fuzzy_score:%s", candidates[0][0])
    logger.info(
        "[MascotFallback] matched reaction: %s",
        {
            "id": matched.get("id"),
            "name": matched.get("name"),
            "score": candidates[0][0],
            "reactants": matched.get("reactants"),
            "products": matched.get("products"),
        },
    )
    return matched


def _reaction_database_phenomenon(rule: dict) -> str:
    result_data = rule.get("result") or {}
    parts = []
    if rule.get("phenomenon"):
        parts.append(rule["phenomenon"])
    if result_data.get("mascotText"):
        parts.append(result_data["mascotText"])
    if result_data.get("equation"):
        parts.append(f"Phương trình: {result_data['equation']}")
    if not parts and rule.get("products"):
        parts.append("Tạo sản phẩm: " + ", ".join(rule["products"]) + ".")
    return " ".join(parts).strip() or "Không có dữ liệu."


def _reaction_database_title(rule: dict, query: str) -> str:
    if rule.get("name"):
        return rule["name"]
    reactants = [_choose_reaction_alternative(spec, query) for spec in rule.get("reactants", [])]
    reactants = [name for name in reactants if name]
    products = [_choose_reaction_alternative(spec, query) for spec in rule.get("products", [])]
    products = [name for name in products if name]
    if reactants and products:
        return f"Phản ứng {' + '.join(reactants)} tạo {' + '.join(products)}"
    if reactants:
        return f"Phản ứng {' + '.join(reactants)}"
    return rule.get("id") or "Phản ứng trong ReactionDatabase.js"


def _dedupe_names(names: list[str]) -> list[str]:
    seen = set()
    result = []
    for name in names:
        key = _compact_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(name)
    return result


def _build_plan_from_reaction_database(rule: dict, question: str) -> dict:
    reactants = [_choose_reaction_alternative(spec, question) for spec in rule.get("reactants", [])]
    required_species = [_choose_reaction_alternative(spec, question) for spec in rule.get("requiredExistingSpecies", [])]
    catalyst = (rule.get("conditions") or {}).get("catalyst")
    chemical_names = _dedupe_names([name for name in [*reactants, *required_species, catalyst] if name])

    chemicals = []
    steps = []
    for index, name in enumerate(chemical_names, start=1):
        record = _resolve_chemical_from_context(name)
        chemicals.append({
            "canonical_id": record["canonical_id"],
            "name_vi": record["name_vi"],
            "name_en": record["name_en"],
            "amount": None,
            "unit": None,
            "tolerance": None,
            "role": "reactant",
        })
        steps.append({
            "step_order": index,
            "chemical_name_vi": record["name_vi"],
            "canonical_id": record["canonical_id"],
            "id_chemical": record.get("id_chemical"),
            "id_tool": None,
            "target_amount": None,
            "unit": None,
            "tolerance": None,
            "action_type": "add",
            "auto_stop": False,
            "heating_required": False,
            "target_temperature": None,
            "action_description": f"Thêm {record['name_vi']}. Không có dữ liệu định lượng trong cơ sở dữ liệu.",
        })

    conditions = rule.get("conditions") or {}
    target_temperature = _coerce_float(conditions.get("minTemperature"))
    heating_required = target_temperature is not None
    if heating_required:
        steps.append({
            "step_order": len(steps) + 1,
            "chemical_name_vi": None,
            "canonical_id": None,
            "id_chemical": None,
            "id_tool": None,
            "target_amount": None,
            "unit": None,
            "tolerance": None,
            "action_type": "heat",
            "auto_stop": False,
            "heating_required": True,
            "target_temperature": target_temperature,
            "action_description": f"Đun nóng đến {_format_amount(target_temperature)}°C.",
        })

    required_tools = [
        "Ống nghiệm hoặc cốc thủy tinh",
        "Giá đỡ",
        "Ống nhỏ giọt/đũa thủy tinh",
    ]
    if heating_required:
        required_tools.append("Dụng cụ gia nhiệt")

    phenomenon = _reaction_database_phenomenon(rule)
    plan = {
        "experiment_id": rule.get("id"),
        "reaction_id": rule.get("id"),
        "title": _reaction_database_title(rule, question),
        "steps": steps,
        "required_chemicals": chemicals,
        "required_tools": required_tools,
        "required_conditions": {
            "temperature_min": target_temperature,
            "temperature_max": conditions.get("maxTemperature"),
            "heating_required": heating_required,
            "order_required": True,
            "catalyst": catalyst,
            "text": None,
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
        "success_reaction_id": rule.get("id"),
        "success_message": phenomenon,
        "phenomenon": phenomenon,
        "fail_messages": {
            "wrong_chemical": "Bạn đã dùng sai hóa chất.",
            "missing_chemical": "Bạn chưa lấy đủ hóa chất cần thiết.",
            "wrong_amount": "Cơ sở dữ liệu phản ứng chưa có định lượng để kiểm tra lượng.",
            "wrong_order": "Bạn đã thực hiện sai thứ tự thao tác.",
            "wrong_temperature": "Điều kiện nhiệt độ chưa phù hợp.",
            "wrong_reaction": "Phản ứng tạo ra không khớp thí nghiệm đã chọn.",
        },
        "knowledge_source_priority": "ReactionDatabase.js",
        "source_documents": [{
            "id": rule.get("id"),
            "source_table": "ReactionDatabase.js",
            "score": None,
            "lexical_overlap": None,
            "selected_score": None,
            "metadata": {
                "name": rule.get("name"),
                "aliases": rule.get("aliases"),
                "keywords": rule.get("keywords"),
                "reactants": rule.get("reactants"),
                "products": rule.get("products"),
                "conditions": rule.get("conditions"),
                "phenomenon": rule.get("phenomenon"),
            },
        }],
    }
    logger.info("RAG generated_experiment_plan=%s", json.dumps(plan, ensure_ascii=False))
    return plan


def build_plan_from_reaction_database(question: str) -> tuple[dict | None, str | None, dict]:
    rule = search_reaction_database(question)
    if not rule:
        return None, None, {"ok": False, "issues": ["no_reaction_database_match"]}
    plan = _build_plan_from_reaction_database(rule, question)
    query_validation = validate_plan_matches_query(plan, question)
    if not query_validation["ok"]:
        logger.info("[MascotFallback] rejected ReactionDatabase plan by query validation: %s", query_validation)
        return None, None, {
            "ok": False,
            "issues": ["reaction_database_plan_not_matching_query", *query_validation.get("issues", [])],
            "source": "ReactionDatabase.js",
            "reaction_id": rule.get("id"),
            "plan_vs_user_query": query_validation,
        }
    answer_text = _format_answer_from_plan(plan)
    return plan, answer_text, {
        "ok": True,
        "issues": [],
        "source": "ReactionDatabase.js",
        "reaction_id": rule.get("id"),
        "plan_vs_user_query": query_validation,
    }


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
    query_validation = validate_plan_matches_query(plan, question)
    if not query_validation["ok"]:
        logger.info("RAG rejected extracted plan by query validation: %s", query_validation)
        return None, None, {
            "ok": False,
            "issues": ["retrieved_plan_not_matching_query", *query_validation.get("issues", [])],
            "plan_vs_user_query": query_validation,
        }
    answer_text = _format_answer_from_plan(plan)
    validation = {**validation, "plan_vs_user_query": query_validation}
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
        response = _run_with_timeout(
            "general answer generation",
            RAG_GENERAL_TIMEOUT_SECONDS,
            None,
            agent.invoke,
            {"messages": input_messages},
        )
        if response is None:
            return "Xin lỗi, Mascot mất quá lâu để phản hồi. Bạn thử hỏi lại hoặc diễn đạt ngắn hơn nhé!"
        raw_answer = response["messages"][-1].content
        logger.info("RAG raw_llm_response=%s", raw_answer)
        return _extract_answer_text(raw_answer)
    except Exception as exc:
        logger.exception("Error in ask_questions: %s", exc)
        return "Xin lỗi, mình gặp chút trục trặc khi xử lý câu hỏi. Bạn thử lại nhé!"


def ask_questions_with_plan(question: str, selected_subject: str, history: list = None):
    is_experiment_query = _is_chemistry_subject(selected_subject) and _is_experiment_question(question)
    docs = retrieve_knowledge_documents_safe(question, selected_subject, k=8) if is_experiment_query else []

    if is_experiment_query:
        plan, answer_text, extraction_validation = _run_with_timeout(
            "experiment plan extraction",
            RAG_EXTRACTION_TIMEOUT_SECONDS,
            (None, None, {"ok": False, "issues": ["llm_extraction_timeout"]}),
            build_experiment_plan,
            question,
            selected_subject=selected_subject,
            retrieved_docs=docs,
        )
        if not plan:
            fallback_plan, fallback_answer, fallback_validation = build_plan_from_reaction_database(question)
            if fallback_plan:
                validations = {
                    "extraction": extraction_validation,
                    "reaction_database_fallback": fallback_validation,
                    "answer_text_vs_plan": validate_answer_matches_plan(fallback_answer, fallback_plan),
                    "plan_vs_reaction_database": {"ok": True, "issues": []},
                    "plan_vs_user_query": validate_plan_matches_query(fallback_plan, question),
                }
                logger.info("[MascotFallback] final source: ReactionDatabase.js")
                logger.info("RAG consistency validation result=%s", validations)
                return {
                    "answer_text": fallback_answer,
                    "experiment_plan": fallback_plan,
                    "retrieved_documents": [_doc_brief(doc) for doc in docs] + fallback_plan.get("source_documents", []),
                    "consistency_validation": validations,
                    "is_experiment_query": True,
                }

            result = {
                "answer_text": NO_EXPERIMENT_DATA_MESSAGE,
                "experiment_plan": None,
                "retrieved_documents": [_doc_brief(doc) for doc in docs],
                "consistency_validation": {
                    "extraction": extraction_validation,
                    "reaction_database_fallback": fallback_validation,
                    "answer_text_vs_plan": {"ok": True, "issues": []},
                    "plan_vs_retrieved_context": {"ok": False, "issues": extraction_validation.get("issues", [])},
                },
                "is_experiment_query": True,
            }
            logger.info("[MascotFallback] final source: none")
            logger.info("RAG consistency validation result=%s", result["consistency_validation"])
            return result

        validations = {
            "extraction": extraction_validation,
            "answer_text_vs_plan": validate_answer_matches_plan(answer_text, plan),
            "plan_vs_retrieved_context": validate_plan_against_documents(plan, docs),
            "plan_vs_user_query": validate_plan_matches_query(plan, question),
        }
        logger.info("[MascotFallback] final source: langchain_bg_embedding")
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
