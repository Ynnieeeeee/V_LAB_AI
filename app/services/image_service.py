import re
import unicodedata
import io
import os
import time
import hashlib
from urllib.parse import urlparse

import requests
from sqlmodel import select, Session

from app.config import SERPAPI_KEY
from app.models.tools import Tools
from app.utils.tool_classifier import ensure_tools_metadata_columns

try:
    from serpapi import GoogleSearch
except Exception:
    GoogleSearch = None

try:
    from PIL import Image, ImageFilter
except Exception:
    Image = None
    ImageFilter = None


IMAGE_SCORE_THRESHOLD = 28
IMAGE_VISUAL_SCORE_THRESHOLD = 8
IMAGE_METADATA_FALLBACK_THRESHOLD = 42
MAX_IMAGE_RESULTS = 20
MAX_VALIDATED_CANDIDATES = 14
REQUIRE_SINGLE_OBJECT_IMAGE_VALIDATION = True
IMAGE_FETCH_TIMEOUT = 8
CLEANED_IMAGE_DIR = os.path.join("app", "static", "cleaned_tool_images")
CLEANED_IMAGE_URL_PREFIX = "/static/cleaned_tool_images"
CLEANED_IMAGE_CANVAS_SIZE = 768
MAX_IMAGE_SEARCH_ATTEMPTS = 5
SINGLE_IMAGE_FAILURE_MESSAGE = "Không thể tạo ảnh chỉ có một dụng cụ duy nhất. Vui lòng thử lại với tên dụng cụ cụ thể hơn."
NEGATIVE_IMAGE_PROMPT = (
    "multiple objects, duplicates, collection, set, row, group, many tools, "
    "repeated objects, extra laboratory equipment, cropped object, text-only image, "
    "book cover, document scan"
)

GLASS_LIKE_TOOL_HINTS = (
    "container",
    "gas_tube",
    "gas_collector",
    "dropping_funnel",
    "funnel",
    "measuring_tool",
    "stirring_tool",
    "glass",
    "beaker",
    "flask",
    "test tube",
    "tube",
    "pipette",
    "burette",
    "cylinder",
)

SUBJECT_CONTEXTS = {
    "chemistry": {
        "query": "chemistry laboratory equipment",
        "positive": ("chemistry", "chemical", "laboratory", "lab glassware", "scientific apparatus"),
        "negative": ("physics experiment kit", "biology specimen", "medical device"),
    },
    "biology": {
        "query": "biology laboratory equipment",
        "positive": ("biology", "biological", "laboratory", "microscope lab", "specimen", "life science"),
        "negative": ("chemistry glassware set", "physics experiment kit", "industrial chemical"),
    },
    "physics": {
        "query": "physics laboratory apparatus",
        "positive": ("physics", "physical science", "laboratory apparatus", "school physics", "demonstration apparatus"),
        "negative": ("chemistry glassware", "biology specimen", "medical device"),
    },
    "general": {
        "query": "scientific laboratory equipment",
        "positive": ("laboratory", "scientific", "equipment", "apparatus"),
        "negative": (),
    },
}

PREFERRED_DOMAINS = (
    "eisco",
    "fisher",
    "thermofisher",
    "coleparmer",
    "carolina",
    "unitedsci",
    "humboldtmfg",
    "labdepotinc",
    "homesciencetools",
    "wardsci",
    "flinnsci",
    "borosil",
    "himedia",
    "sigmaaldrich",
    "fishersci",
    "grainger",
)

BLOCKED_OR_WEAK_DOMAINS = (
    "shutterstock",
    "istockphoto",
    "alamy",
    "dreamstime",
    "freepik",
    "vecteezy",
    "pngtree",
    "vectorstock",
    "depositphotos",
    "123rf",
    "pinterest",
    "dreamstime",
    "gettyimages",
)

DOCUMENT_IMAGE_DOMAINS = (
    "calameo",
    "calameoassets",
    "issuu",
    "scribd",
    "slideshare",
    "pdfcoffee",
    "pdfdrive",
    "academia",
    "coursehero",
    "studocu",
    "springer",
    "springernature",
    "nature.com",
    "sciencedirect",
    "elsevier",
    "mdpi",
    "frontiersin",
    "wiley",
    "tandfonline",
    "researchgate",
    "arxiv",
    "pubmed",
    "ncbi",
    "plos",
    "biorxiv",
    "medrxiv",
    "ieee",
    "acm.org",
)

NON_TOOL_FIGURE_TERMS = (
    "graphical abstract",
    "schematic diagram",
    "conceptual diagram",
    "workflow",
    "flowchart",
    "research article",
    "review article",
    "journal article",
    "mediaobjects",
    "springer-static",
    "html.png",
    "figure",
    "fig.",
    "infographic",
    "diagram",
    "illustration",
    "drawing",
    "cartoon",
    "vector",
    "clipart",
)

NEGATIVE_TERMS = (
    "vector",
    "icon",
    "clipart",
    "illustration",
    "drawing",
    "cartoon",
    "logo",
    "diagram",
    "worksheet",
    "experiment setup",
    "background",
    "infographic",
    "banner",
    "stock photo",
    "set of",
    "collection of",
    "watermark",
    "logo",
    "banner",
    "poster",
    "labeled",
    "labelled",
    "text overlay",
    "book cover",
    "ebook",
    "textbook",
    "pdf",
    "manual",
    "document",
    "publication",
    "read online",
    "cropped",
    "partial view",
    "close up",
    "schematic",
    "graphical abstract",
    "workflow",
    "flowchart",
    "figure",
    "research article",
    "review article",
    "journal",
)

SINGLE_OBJECT_POSITIVE_TERMS = (
    "single",
    "single item",
    "one piece",
    "1 piece",
    "one unit",
    "individual",
    "each",
    "isolated product",
    "product photo",
)

MULTI_OBJECT_NEGATIVE_PATTERNS = (
    r"\bset\s+of\b",
    r"\bpack\s+of\b",
    r"\blot\s+of\b",
    r"\b\d+\s*(pcs|pieces|piece|pack|packs|units|count|set|sets)\b",
    r"\b\d+\s*[- ]?pack\b",
    r"\b\d+\s*x\b",
    r"\b(multiple|assorted|assortment|bundle|bulk|pair|pairs|collection|kit)\b",
    r"\b(glassware|apparatus)\s+(set|kit|collection)\b",
    r"\b(test\s+tubes|beakers|flasks|pipettes|burettes|funnels|burners|stands|clamps|rods|cylinders)\b",
)

BASE_POSITIVE_TERMS = (
    "laboratory",
    "lab",
    "equipment",
    "apparatus",
    "glassware",
    "product",
    "photo",
    "full object",
    "uncropped",
)

TOOL_PROFILES = {
    "heating_source": {
        "canonical": "laboratory spirit lamp alcohol burner",
        "must_any": ("spirit lamp", "alcohol burner", "alcohol lamp", "bunsen burner", "hot plate", "laboratory burner"),
        "positive": ("laboratory", "burner", "lamp", "glass", "metal cap", "wick", "product"),
        "strict_single_visual": True,
    },
    "support_stand": {
        "canonical": "laboratory tripod stand support stand",
        "must_any": ("tripod stand", "support stand", "ring stand", "lab stand", "iron tripod"),
        "positive": ("laboratory", "stand", "tripod", "support", "ring", "clamp", "product"),
        "strict_single_visual": False,
    },
    "container": {
        "canonical": "",
        "must_any": ("beaker", "test tube", "flask", "erlenmeyer", "round bottom flask", "glassware"),
        "positive": ("laboratory", "glassware", "borosilicate", "graduated", "product", "white background"),
        "strict_single_visual": True,
    },
    "dropping_funnel": {
        "canonical": "laboratory dropping funnel addition funnel",
        "must_any": ("dropping funnel", "addition funnel"),
        "positive": ("laboratory", "glassware", "stopcock", "product"),
        "strict_single_visual": True,
    },
    "funnel": {
        "canonical": "laboratory glass funnel",
        "must_any": ("glass funnel", "filter funnel", "laboratory funnel"),
        "positive": ("laboratory", "glassware", "funnel", "product"),
        "strict_single_visual": True,
    },
    "gas_tube": {
        "canonical": "laboratory gas delivery tube glass tubing",
        "must_any": ("delivery tube", "gas delivery tube", "glass tubing", "rubber tubing"),
        "positive": ("laboratory", "tube", "tubing", "glass", "product"),
        "strict_single_visual": True,
    },
    "gas_collector": {
        "canonical": "laboratory gas jar gas collection bottle",
        "must_any": ("gas jar", "gas collection bottle", "gas collector"),
        "positive": ("laboratory", "jar", "bottle", "collection", "product"),
        "strict_single_visual": True,
    },
    "stirring_tool": {
        "canonical": "laboratory glass stirring rod",
        "must_any": ("glass stirring rod", "stirring rod", "glass rod"),
        "positive": ("laboratory", "rod", "glass", "product"),
        "strict_single_visual": True,
    },
    "measuring_tool": {
        "canonical": "laboratory graduated cylinder measuring cylinder",
        "must_any": ("graduated cylinder", "measuring cylinder", "pipette", "burette"),
        "positive": ("laboratory", "graduated", "measure", "volume", "product"),
        "strict_single_visual": True,
    },
    "clamp_tool": {
        "canonical": "laboratory utility clamp test tube clamp",
        "must_any": ("utility clamp", "test tube clamp", "bosshead", "laboratory clamp"),
        "positive": ("laboratory", "clamp", "holder", "product"),
        "strict_single_visual": False,
    },
}

NAME_OVERRIDES = (
    (("erlenmeyer", "triangle flask", "binh tam giac"), {
        "canonical": "erlenmeyer flask laboratory glassware",
        "must_any": ("erlenmeyer flask", "conical flask"),
        "positive": ("laboratory", "glassware", "flask", "product"),
        "strict_single_visual": True,
    }),
    (("test tube rack", "gia ong nghiem"), {
        "canonical": "laboratory test tube rack",
        "must_any": ("test tube rack",),
        "positive": ("laboratory", "rack", "holder", "product"),
        "strict_single_visual": False,
    }),
    (("test tube", "ong nghiem"), {
        "canonical": "laboratory test tube glass",
        "must_any": ("test tube",),
        "positive": ("laboratory", "glass", "tube", "product"),
        "strict_single_visual": True,
    }),
    (("beaker", "coc thuy tinh", "coc"), {
        "canonical": "laboratory glass beaker",
        "must_any": ("glass beaker", "laboratory beaker", "beaker"),
        "positive": ("laboratory", "glassware", "graduated", "product"),
        "strict_single_visual": True,
    }),
    (("round bottom flask", "round-bottom flask", "binh cau"), {
        "canonical": "laboratory round bottom flask",
        "must_any": ("round bottom flask", "round-bottom flask"),
        "positive": ("laboratory", "glassware", "flask", "product"),
        "strict_single_visual": True,
    }),
    (("volumetric flask", "binh dinh muc"), {
        "canonical": "laboratory volumetric flask",
        "must_any": ("volumetric flask",),
        "positive": ("laboratory", "glassware", "flask", "product"),
        "strict_single_visual": True,
    }),
    (("graduated cylinder", "measuring cylinder", "ong dong", "ong do", "ong chia vach"), {
        "canonical": "laboratory graduated cylinder",
        "must_any": ("graduated cylinder", "measuring cylinder"),
        "positive": ("laboratory", "graduated", "cylinder", "product"),
        "strict_single_visual": True,
    }),
    (("pipette", "pipet", "ong hut"), {
        "canonical": "laboratory pipette",
        "must_any": ("pipette", "volumetric pipette", "graduated pipette"),
        "positive": ("laboratory", "glassware", "pipette", "product"),
        "strict_single_visual": True,
    }),
    (("burette", "buret"), {
        "canonical": "laboratory burette",
        "must_any": ("burette", "buret"),
        "positive": ("laboratory", "glassware", "burette", "stopcock", "product"),
        "strict_single_visual": True,
    }),
    (("test tube clamp", "utility clamp", "kep ong nghiem", "kep"), {
        "canonical": "laboratory test tube clamp",
        "must_any": ("test tube clamp", "utility clamp", "laboratory clamp"),
        "positive": ("laboratory", "clamp", "holder", "product"),
        "strict_single_visual": False,
    }),
    (("rubber stopper", "stopper", "bung", "nut cao su", "nut binh"), {
        "canonical": "laboratory rubber stopper",
        "must_any": ("rubber stopper", "stopper"),
        "positive": ("laboratory", "rubber", "stopper", "product"),
        "strict_single_visual": True,
    }),
    (("petri dish", "dia petri"), {
        "canonical": "laboratory petri dish",
        "must_any": ("petri dish",),
        "positive": ("laboratory", "biology", "dish", "product"),
        "strict_single_visual": True,
    }),
    (("microscope", "kinh hien vi"), {
        "canonical": "laboratory microscope",
        "must_any": ("microscope",),
        "positive": ("laboratory", "microscope", "product"),
        "strict_single_visual": True,
    }),
    (("thermometer", "nhiet ke"), {
        "canonical": "laboratory thermometer",
        "must_any": ("thermometer",),
        "positive": ("laboratory", "thermometer", "product"),
        "strict_single_visual": True,
    }),
    (("balance", "scale", "can dien tu", "can ky thuat"), {
        "canonical": "laboratory balance scale",
        "must_any": ("laboratory balance", "balance scale", "digital scale"),
        "positive": ("laboratory", "balance", "scale", "product"),
        "strict_single_visual": True,
    }),
    (("power transformer", "transformer", "bien ap", "bien ap nguon"), {
        "canonical": "laboratory power transformer physics apparatus",
        "must_any": ("power transformer", "transformer"),
        "positive": ("physics", "laboratory", "transformer", "power supply", "apparatus", "product"),
        "strict_single_visual": True,
        "allow_product_labels": True,
        "allow_non_white_background": True,
    }),
    (("power supply", "dc power supply", "nguon dien", "bo nguon"), {
        "canonical": "laboratory DC power supply physics apparatus",
        "must_any": ("power supply", "dc power supply", "laboratory power supply"),
        "positive": ("physics", "laboratory", "power supply", "apparatus", "product"),
        "strict_single_visual": True,
        "allow_product_labels": True,
        "allow_non_white_background": True,
    }),
    (("voltmeter", "von ke"), {
        "canonical": "laboratory voltmeter physics apparatus",
        "must_any": ("voltmeter",),
        "positive": ("physics", "laboratory", "meter", "apparatus", "product"),
        "strict_single_visual": True,
        "allow_product_labels": True,
        "allow_non_white_background": True,
    }),
    (("ammeter", "ampe ke"), {
        "canonical": "laboratory ammeter physics apparatus",
        "must_any": ("ammeter",),
        "positive": ("physics", "laboratory", "meter", "apparatus", "product"),
        "strict_single_visual": True,
        "allow_product_labels": True,
        "allow_non_white_background": True,
    }),
    (("spirit lamp", "alcohol lamp", "den con"), TOOL_PROFILES["heating_source"]),
    (("tripod", "support stand", "ring stand", "gia do", "kieng"), TOOL_PROFILES["support_stand"]),
)


def normalize_text(value: str = "") -> str:
    normalized = unicodedata.normalize("NFD", str(value or ""))
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    without_marks = without_marks.replace("Ä‘", "d").replace("Ä", "d")
    without_marks = without_marks.replace("đ", "d").replace("Đ", "d")
    return re.sub(r"\s+", " ", without_marks.lower()).strip()


def _domain_from_url(value: str = "") -> str:
    try:
        return urlparse(value).netloc.lower()
    except Exception:
        return ""


def _result_text(result: dict) -> str:
    return normalize_text(" ".join(str(result.get(key, "")) for key in (
        "title",
        "source",
        "link",
        "original",
        "thumbnail",
    )))


def _candidate_document_noise(result: dict) -> tuple[bool, list[str]]:
    url = result.get("original") or result.get("thumbnail") or result.get("link", "")
    text_value = _result_text(result)
    domain = _domain_from_url(url)
    domain_hits = [term for term in DOCUMENT_IMAGE_DOMAINS if term in domain or term in text_value]
    text_hits = [
        term for term in (
            "book cover",
            "ebook",
            "textbook",
            "pdf",
            "manual",
            "document",
            "publication",
            "read online",
            "article",
            "journal",
            "study",
        )
        if term in text_value
    ]
    figure_hits = [term for term in NON_TOOL_FIGURE_TERMS if term in text_value]
    reasons = []
    if domain_hits:
        reasons.append(f"document_domain={domain_hits[:3]}")
    if text_hits:
        reasons.append(f"document_text={text_hits[:4]}")
    if figure_hits:
        reasons.append(f"figure_text={figure_hits[:4]}")
    return bool(domain_hits or text_hits or figure_hits), reasons


def _profile_for(tool_name_en: str = "", tool_name_vi: str = "", tool_type: str = "") -> dict:
    text_value = normalize_text(f"{tool_name_vi} {tool_name_en} {tool_type}")
    for keywords, profile in NAME_OVERRIDES:
        if any(keyword in text_value for keyword in keywords):
            return profile
    profile = TOOL_PROFILES.get(str(tool_type or "").lower(), {})
    if profile:
        return profile
    return {
        "canonical": tool_name_en,
        "must_any": tuple(part for part in normalize_text(tool_name_en).split(" ") if len(part) > 2),
        "positive": BASE_POSITIVE_TERMS,
    }


def _subject_context(subject_code: str = "general") -> dict:
    return SUBJECT_CONTEXTS.get(str(subject_code or "general").lower(), SUBJECT_CONTEXTS["general"])


def _single_object_prompt(canonical: str) -> str:
    return (
        f"Create a clean product-style image of exactly ONE {canonical}. "
        "The image must contain only one single object with the full object visible and uncropped. "
        "No duplicates, no set, no collection, no row of objects, no repeated copies, no extra tools. "
        "Simple or natural background is allowed. Front view or a slight angled view is allowed."
    )


def _build_queries(tool_name_en: str, tool_name_vi: str = "", tool_type: str = "", subject_code: str = "general") -> list[str]:
    profile = _profile_for(tool_name_en, tool_name_vi, tool_type)
    canonical = profile.get("canonical") or tool_name_en
    subject = _subject_context(subject_code)
    subject_query = subject["query"]
    base = normalize_text(canonical).replace(" ", " ")
    background_phrase = "real product photo full object visible uncropped clear angle"
    first_background_phrase = "single product photo full object visible uncropped simple background"
    exclude_multi = (
        '-"set of" -"pack of" -"row of" -"group of" -"many" -"multiple" '
        '-duplicates -duplicate -bundle -assorted -collection -kit -lot -bulk '
        '-"repeated" -"repeated copies"'
    )
    plural_terms = [
        '"test tubes"',
        '"gas delivery tubes"',
        '"glass tubes"',
        "beakers",
        "flasks",
        "pipettes",
        "burettes",
        "funnels",
        "burners",
        "stands",
        "clamps",
        "cylinders",
    ]
    current_text = normalize_text(f"{canonical} {tool_name_en} {tool_type}")
    plural_terms = [
        term for term in plural_terms
        if term.strip('"').rstrip("s") not in current_text
    ]
    exclude_plural_tools = " ".join(f"-{term}" for term in plural_terms)
    exclude_dirty_background = (
        '-watermark -logo -"text overlay" -banner -poster -diagram -illustration '
        '-"book cover" -ebook -textbook -pdf -manual -document -publication '
        '-figure -schematic -workflow -flowchart -"graphical abstract" -"research article" '
        '-springer -springernature -mdpi -sciencedirect -researchgate -calameo -issuu -scribd '
        '-slideshare -cropped -"partial view" -"close up"'
    )
    return [
        f'"{canonical}" {subject_query} exactly one single object one laboratory tool full object visible uncropped {first_background_phrase} no duplicates no set no collection no row no repeated copies {exclude_multi} {exclude_plural_tools} {exclude_dirty_background}',
        f'{base} {subject_query} only one single laboratory tool one piece {background_phrase} front view or slight angle no extra tools no multiple objects {exclude_multi} {exclude_plural_tools} {exclude_dirty_background}',
        f'{base} {subject_query} individual apparatus exactly one object only one tool clear product photo full body visible not cropped no collection no repeated copies {exclude_multi} {exclude_plural_tools} {exclude_dirty_background}',
        f'"{canonical}" laboratory equipment catalog product photo single item full object uncropped {exclude_multi} {exclude_plural_tools} {exclude_dirty_background}',
        f'{base} science lab apparatus product image one item full object visible buy catalog photo {exclude_multi} {exclude_plural_tools} {exclude_dirty_background}',
    ]


def _score_image_result(result: dict, profile: dict, subject_code: str = "general") -> tuple[int, list[str]]:
    url = result.get("original") or result.get("thumbnail") or ""
    text_value = _result_text(result)
    domain = _domain_from_url(url or result.get("link", ""))
    subject = _subject_context(subject_code)
    score = 0
    reasons = []

    if url:
        score += 5
        reasons.append("has_url")

    document_noise, document_reasons = _candidate_document_noise(result)
    if document_noise:
        score -= 95
        reasons.extend(document_reasons)

    must_any = tuple(normalize_text(term) for term in profile.get("must_any", ()) if term)
    if must_any:
        matched = [term for term in must_any if term in text_value]
        if matched:
            score += 24 + min(16, len(matched) * 4)
            reasons.append(f"must={matched[:3]}")
        else:
            score -= 35
            reasons.append("missing_must")

    positive_terms = tuple(profile.get("positive", ())) + BASE_POSITIVE_TERMS
    positive_hits = [term for term in positive_terms if normalize_text(term) in text_value]
    if positive_hits:
        score += min(24, len(set(positive_hits)) * 3)
        reasons.append(f"positive={positive_hits[:5]}")

    subject_hits = [term for term in subject.get("positive", ()) if normalize_text(term) in text_value]
    if subject_hits:
        score += min(18, len(set(subject_hits)) * 4)
        reasons.append(f"subject={subject_hits[:4]}")

    wrong_subject_hits = [term for term in subject.get("negative", ()) if normalize_text(term) in text_value]
    if wrong_subject_hits:
        score -= min(35, len(set(wrong_subject_hits)) * 14)
        reasons.append(f"wrong_subject={wrong_subject_hits[:3]}")

    if any(term in text_value or term in domain for term in PREFERRED_DOMAINS):
        score += 15
        reasons.append("preferred_domain")

    blocked_hits = [term for term in BLOCKED_OR_WEAK_DOMAINS if term in text_value or term in domain]
    if blocked_hits:
        score -= 35
        reasons.append(f"weak_domain={blocked_hits[:2]}")

    negative_hits = [term for term in NEGATIVE_TERMS if term in text_value]
    if negative_hits:
        score -= min(45, len(negative_hits) * 12)
        reasons.append(f"negative={negative_hits[:4]}")

    single_hits = [term for term in SINGLE_OBJECT_POSITIVE_TERMS if term in text_value]
    if single_hits:
        score += min(18, len(set(single_hits)) * 4)
        reasons.append(f"single={single_hits[:4]}")

    multi_hits = [pattern for pattern in MULTI_OBJECT_NEGATIVE_PATTERNS if re.search(pattern, text_value)]
    if multi_hits:
        score -= min(60, len(multi_hits) * 20)
        reasons.append(f"multi_object={multi_hits[:3]}")

    width = int(result.get("original_width") or result.get("width") or 0)
    height = int(result.get("original_height") or result.get("height") or 0)
    if width and height:
        if width >= 300 and height >= 300:
            score += 8
            reasons.append("good_size")
        if width < 180 or height < 180:
            score -= 10
            reasons.append("small")
        ratio = max(width / max(height, 1), height / max(width, 1))
        if ratio > 3.2:
            score -= 8
            reasons.append("bad_ratio")

    if re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", url.lower()):
        score += 3
        reasons.append("image_ext")

    return score, reasons


def _has_reason_prefix(reasons: list[str], prefixes: tuple[str, ...]) -> bool:
    return any(str(reason).startswith(prefixes) for reason in reasons)


def _metadata_fallback_candidate(candidates: list[dict]):
    for candidate in sorted(
        candidates,
        key=lambda item: item.get("metadata_score", item.get("score", 0)),
        reverse=True,
    ):
        metadata_score = candidate.get("metadata_score", candidate.get("score", 0))
        reasons = candidate.get("reasons", [])
        if metadata_score < IMAGE_METADATA_FALLBACK_THRESHOLD:
            continue
        if candidate.get("image_validation_ok") is False and not _has_reason_prefix(
            reasons,
            ("image_validation_failed=", "image_validation_unavailable"),
        ):
            continue
        if "missing_must" in reasons:
            continue
        if _has_reason_prefix(reasons, (
            "document_",
            "figure_",
            "negative=",
            "multi_object=",
            "wrong_subject=",
            "weak_domain=",
        )):
            continue
        strong_match = (
            _has_reason_prefix(reasons, ("must=", "positive=", "subject=", "single="))
            or "preferred_domain" in reasons
        )
        if strong_match:
            return candidate
    return None


def _safe_int(value, default=0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _resize_for_validation(image):
    image = image.convert("RGBA")
    width, height = image.size
    max_side = max(width, height)
    if max_side > 420:
        scale = 420 / max_side
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))))
    return image


def _estimate_background_rgb(pixels, width, height):
    samples = []
    for x in range(width):
        samples.append(pixels[x, 0][:3])
        samples.append(pixels[x, height - 1][:3])
    for y in range(height):
        samples.append(pixels[0, y][:3])
        samples.append(pixels[width - 1, y][:3])

    bright_samples = [rgb for rgb in samples if sum(rgb) / 3 >= 180]
    if len(bright_samples) >= max(8, len(samples) * 0.2):
        samples = bright_samples

    channels = []
    for channel in range(3):
        values = sorted(rgb[channel] for rgb in samples)
        channels.append(values[len(values) // 2] if values else 255)
    return tuple(channels)


def _foreground_mask(image):
    image = _resize_for_validation(image)
    pixels = image.load()
    width, height = image.size
    bg = _estimate_background_rgb(pixels, width, height)
    mask = [[False for _ in range(width)] for _ in range(height)]

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < 32:
                continue
            brightness = (r + g + b) / 3
            color_distance = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])
            channel_spread = max(r, g, b) - min(r, g, b)
            dark_line = brightness < 225 and color_distance > 35
            colored = channel_spread > 24 and brightness < 248
            non_white_edge = color_distance > 55 and brightness < 245
            mask[y][x] = dark_line or colored or non_white_edge

    return mask, width, height, image


def _count_components(mask, width, height):
    visited = [[False for _ in range(width)] for _ in range(height)]
    components = []
    total_foreground = sum(1 for row in mask for value in row if value)
    if total_foreground == 0:
        return [], 0

    min_area = max(80, int(total_foreground * 0.06))
    for start_y in range(height):
        for start_x in range(width):
            if visited[start_y][start_x] or not mask[start_y][start_x]:
                continue
            stack = [(start_x, start_y)]
            visited[start_y][start_x] = True
            area = 0
            min_x = max_x = start_x
            min_y = max_y = start_y
            while stack:
                x, y = stack.pop()
                area += 1
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                for ny in range(max(0, y - 1), min(height, y + 2)):
                    for nx in range(max(0, x - 1), min(width, x + 2)):
                        if visited[ny][nx] or not mask[ny][nx]:
                            continue
                        visited[ny][nx] = True
                        stack.append((nx, ny))
            if area >= min_area:
                components.append({
                    "area": area,
                    "bbox": (min_x, min_y, max_x, max_y),
                })
    return components, total_foreground


def _all_components(mask, width, height, min_area=10):
    visited = [[False for _ in range(width)] for _ in range(height)]
    components = []
    for start_y in range(height):
        for start_x in range(width):
            if visited[start_y][start_x] or not mask[start_y][start_x]:
                continue
            stack = [(start_x, start_y)]
            visited[start_y][start_x] = True
            area = 0
            min_x = max_x = start_x
            min_y = max_y = start_y
            while stack:
                x, y = stack.pop()
                area += 1
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                for ny in range(max(0, y - 1), min(height, y + 2)):
                    for nx in range(max(0, x - 1), min(width, x + 2)):
                        if visited[ny][nx] or not mask[ny][nx]:
                            continue
                        visited[ny][nx] = True
                        stack.append((nx, ny))
            if area >= min_area:
                components.append({
                    "area": area,
                    "bbox": (min_x, min_y, max_x, max_y),
                })
    return components


def _expanded_bbox(bbox, width, height, margin_ratio=0.08):
    min_x, min_y, max_x, max_y = bbox
    margin_x = max(8, int(width * margin_ratio))
    margin_y = max(8, int(height * margin_ratio))
    return (
        max(0, min_x - margin_x),
        max(0, min_y - margin_y),
        min(width - 1, max_x + margin_x),
        min(height - 1, max_y + margin_y),
    )


def _component_center(component):
    min_x, min_y, max_x, max_y = component["bbox"]
    return ((min_x + max_x) / 2, (min_y + max_y) / 2)


def _point_inside_bbox(point, bbox):
    x, y = point
    min_x, min_y, max_x, max_y = bbox
    return min_x <= x <= max_x and min_y <= y <= max_y


def _validate_plain_background(image, mask, main_bbox):
    pixels = image.load()
    width, height = image.size
    edge_total = 0
    edge_clean = 0

    def is_clean_background_pixel(x, y):
        r, g, b, a = pixels[x, y]
        if a < 32:
            return True
        brightness = (r + g + b) / 3
        spread = max(r, g, b) - min(r, g, b)
        return brightness >= 238 and spread <= 28

    for x in range(width):
        for y in (0, height - 1):
            edge_total += 1
            if is_clean_background_pixel(x, y):
                edge_clean += 1
    for y in range(height):
        for x in (0, width - 1):
            edge_total += 1
            if is_clean_background_pixel(x, y):
                edge_clean += 1

    edge_clean_ratio = edge_clean / max(edge_total, 1)

    expanded_main = _expanded_bbox(main_bbox, width, height, margin_ratio=0.04)
    bg_total = 0
    bg_clean = 0
    stride = 2
    for y in range(0, height, stride):
        for x in range(0, width, stride):
            if mask[y][x] or _point_inside_bbox((x, y), expanded_main):
                continue
            bg_total += 1
            if is_clean_background_pixel(x, y):
                bg_clean += 1

    bg_clean_ratio = bg_clean / max(bg_total, 1)
    reasons = [
        f"edge_clean={edge_clean_ratio:.2f}",
        f"bg_clean={bg_clean_ratio:.2f}",
    ]

    if edge_clean_ratio < 0.90:
        return {"ok": False, "reasons": reasons + ["reject_non_white_edges"]}
    if bg_total > 50 and bg_clean_ratio < 0.86:
        return {"ok": False, "reasons": reasons + ["reject_non_white_background"]}
    return {"ok": True, "reasons": reasons + ["plain_background_ok"]}


def _detect_external_logo_or_text(mask, width, height, main_bbox):
    all_components = _all_components(mask, width, height, min_area=max(8, int(width * height * 0.00025)))
    expanded_main = _expanded_bbox(main_bbox, width, height, margin_ratio=0.10)
    external_components = []
    for component in all_components:
        if _point_inside_bbox(_component_center(component), expanded_main):
            continue
        external_components.append(component)

    external_area = sum(component["area"] for component in external_components)
    area_ratio = external_area / max(width * height, 1)
    reasons = [
        f"external_components={len(external_components)}",
        f"external_area={area_ratio:.3f}",
    ]
    if len(external_components) >= 2:
        return {"ok": False, "reasons": reasons + ["reject_logo_or_text_components"]}
    if len(external_components) == 1 and area_ratio >= 0.002:
        return {"ok": False, "reasons": reasons + ["reject_logo_or_text_component"]}
    return {"ok": True, "reasons": reasons + ["no_external_logo_text"]}


def _detect_text_only_or_cover_image(mask, width, height, components, total_foreground):
    points = [
        (x, y)
        for y, row in enumerate(mask)
        for x, value in enumerate(row)
        if value
    ]
    if not points:
        return {"ok": False, "reasons": ["reject_text_only_no_foreground"]}

    min_x = min(point[0] for point in points)
    max_x = max(point[0] for point in points)
    min_y = min(point[1] for point in points)
    max_y = max(point[1] for point in points)
    union_width_ratio = (max_x - min_x + 1) / max(width, 1)
    union_height_ratio = (max_y - min_y + 1) / max(height, 1)
    foreground_ratio = total_foreground / max(width * height, 1)
    small_components = _all_components(mask, width, height, min_area=max(4, int(width * height * 0.00003)))
    largest_ratio = 0
    if components and total_foreground:
        largest_ratio = max(component["area"] for component in components) / max(total_foreground, 1)

    reasons = [
        f"fg_ratio={foreground_ratio:.3f}",
        f"union_bbox=({union_width_ratio:.2f},{union_height_ratio:.2f})",
        f"small_components={len(small_components)}",
        f"largest_fg_ratio={largest_ratio:.2f}",
    ]
    if (
        foreground_ratio < 0.065
        and union_width_ratio < 0.62
        and union_height_ratio < 0.45
        and len(small_components) >= 3
    ):
        return {"ok": False, "reasons": reasons + ["reject_text_only_or_book_cover"]}
    if foreground_ratio < 0.035 and union_width_ratio < 0.75 and union_height_ratio < 0.65:
        return {"ok": False, "reasons": reasons + ["reject_sparse_text_only_image"]}
    return {"ok": True, "reasons": reasons + ["not_text_only"]}


def _detect_diagram_or_infographic_image(mask, width, height, components, total_foreground):
    if not components or not total_foreground:
        return {"ok": False, "reasons": ["reject_diagram_no_tool_component"]}

    small_components = _all_components(mask, width, height, min_area=max(6, int(width * height * 0.00005)))
    medium_components = [
        component for component in small_components
        if component["area"] >= max(24, int(total_foreground * 0.01))
    ]
    largest_ratio = max(component["area"] for component in components) / max(total_foreground, 1)
    fine_x_groups = _count_x_foreground_groups(mask, width, height, 0.0, 1.0, 0.045)
    foreground_ratio = total_foreground / max(width * height, 1)
    reasons = [
        f"diagram_components={len(components)}",
        f"diagram_small_components={len(small_components)}",
        f"diagram_medium_components={len(medium_components)}",
        f"diagram_x_groups={len(fine_x_groups)}",
        f"diagram_largest_fg_ratio={largest_ratio:.2f}",
        f"diagram_fg_ratio={foreground_ratio:.2f}",
    ]

    if len(components) >= 8:
        return {"ok": False, "reasons": reasons + ["reject_many_visual_regions"]}
    if len(components) >= 5 and largest_ratio < 0.55:
        return {"ok": False, "reasons": reasons + ["reject_multi_panel_or_diagram"]}
    if len(small_components) >= 34 and len(medium_components) >= 10 and largest_ratio < 0.62:
        return {"ok": False, "reasons": reasons + ["reject_infographic_many_parts"]}
    if len(fine_x_groups) >= 8 and largest_ratio < 0.62:
        return {"ok": False, "reasons": reasons + ["reject_diagram_layout"]}
    return {"ok": True, "reasons": reasons + ["not_diagram"]}


def _count_x_foreground_groups(mask, width, height, y_start_ratio=0.0, y_end_ratio=1.0, threshold_ratio=0.08):
    y_start = max(0, min(height - 1, int(height * y_start_ratio)))
    y_end = max(y_start + 1, min(height, int(height * y_end_ratio)))
    region_height = max(1, y_end - y_start)
    column_counts = [sum(1 for y in range(y_start, y_end) if mask[y][x]) for x in range(width)]
    threshold = max(5, int(region_height * threshold_ratio))
    active = [count >= threshold for count in column_counts]

    groups = []
    start = None
    gap = 0
    max_gap = max(3, int(width * 0.012))
    for index, is_active in enumerate(active):
        if is_active:
            if start is None:
                start = index
            gap = 0
        elif start is not None:
            gap += 1
            if gap > max_gap:
                end = index - gap
                if end - start + 1 >= max(6, int(width * 0.025)):
                    groups.append((start, end))
                start = None
                gap = 0
    if start is not None:
        end = width - 1
        if end - start + 1 >= max(6, int(width * 0.025)):
            groups.append((start, end))
    return groups


def _count_large_separate_components(components, total_foreground):
    min_area = max(80, int(total_foreground * 0.12))
    return sum(1 for component in components if component["area"] >= min_area)


def _repeated_component_count(components, total_foreground, width):
    if not components:
        return 0
    sorted_components = sorted(components, key=lambda component: component["area"], reverse=True)
    largest_area = sorted_components[0]["area"]
    min_area = max(45, int(total_foreground * 0.05), int(largest_area * 0.18))
    centers = sorted(
        _component_center(component)[0]
        for component in sorted_components
        if component["area"] >= min_area
    )
    if not centers:
        return 0

    separated_groups = 1
    min_gap = max(12, width * 0.10)
    previous = centers[0]
    for center in centers[1:]:
        if center - previous >= min_gap:
            separated_groups += 1
        previous = center
    return separated_groups


def _validate_image_load(url: str):
    if url and url.startswith("/static/"):
        local_path = _static_url_to_local_path(url)
        if local_path and os.path.exists(local_path):
            return Image.open(local_path)
        raise FileNotFoundError(local_path or url)
    if url and os.path.exists(url):
        return Image.open(url)
    response = requests.get(
        url,
        timeout=IMAGE_FETCH_TIMEOUT,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    response.raise_for_status()
    return Image.open(io.BytesIO(response.content))


def _validation_result(ok: bool, delta: int, reasons: list[str], object_count=0):
    return {
        "ok": ok,
        "delta": delta,
        "reasons": reasons,
        "object_count": max(0, int(object_count or 0)),
    }


def _validate_single_object_image(url: str, profile: dict) -> dict:
    if Image is None:
        return _validation_result(False, -20, ["image_validation_unavailable"], 0)

    try:
        image = _validate_image_load(url)
        mask, width, height, image = _foreground_mask(image)
    except Exception as exc:
        return _validation_result(False, -18, [f"image_validation_failed={type(exc).__name__}"], 0)

    components, total_foreground = _count_components(mask, width, height)
    x_groups = _count_x_foreground_groups(mask, width, height)
    lower_x_groups = _count_x_foreground_groups(mask, width, height, 0.35, 0.98, 0.10)
    large_component_count = _count_large_separate_components(components, total_foreground)
    repeated_component_count = _repeated_component_count(components, total_foreground, width)
    estimated_object_count = max(len(lower_x_groups), large_component_count, repeated_component_count)
    reasons = [
        f"fg_components={len(components)}",
        f"x_groups={len(x_groups)}",
        f"lower_x_groups={len(lower_x_groups)}",
        f"large_components={large_component_count}",
        f"repeated_components={repeated_component_count}",
    ]

    if total_foreground < width * height * 0.015:
        return _validation_result(False, -35, reasons + ["too_little_foreground"], estimated_object_count)

    if not components:
        return _validation_result(False, -35, reasons + ["no_foreground_component"], 0)

    text_only_check = _detect_text_only_or_cover_image(mask, width, height, components, total_foreground)
    if not text_only_check["ok"]:
        return _validation_result(False, -90, reasons + text_only_check["reasons"], estimated_object_count)

    diagram_check = _detect_diagram_or_infographic_image(mask, width, height, components, total_foreground)
    if not diagram_check["ok"]:
        return _validation_result(False, -90, reasons + text_only_check["reasons"] + diagram_check["reasons"], estimated_object_count)

    strict_single = profile.get("strict_single_visual", True)
    component_count = len(components)
    x_group_count = len(x_groups)
    lower_x_group_count = len(lower_x_groups)
    largest = max(components, key=lambda item: item["area"])
    min_x, min_y, max_x, max_y = largest["bbox"]
    allow_product_labels = bool(profile.get("allow_product_labels"))
    background_check = _validate_plain_background(image, mask, largest["bbox"])
    if not background_check["ok"]:
        background_check = {
            "ok": True,
            "reasons": background_check["reasons"] + ["relaxed_background_allowed"],
        }

    noise_check = _detect_external_logo_or_text(mask, width, height, largest["bbox"])
    if not noise_check["ok"] and not allow_product_labels:
        return _validation_result(False, -60, reasons + background_check["reasons"] + noise_check["reasons"], estimated_object_count)
    if not noise_check["ok"]:
        noise_check = {
            "ok": True,
            "reasons": noise_check["reasons"] + ["relaxed_product_labels"],
        }

    touches_edges = (
        min_x <= 2 or
        min_y <= 2 or
        max_x >= width - 3 or
        max_y >= height - 3
    )

    bbox_width = max_x - min_x + 1
    bbox_height = max_y - min_y + 1
    center_offset_x = abs(((min_x + max_x) / 2) - (width / 2)) / max(width, 1)
    center_offset_y = abs(((min_y + max_y) / 2) - (height / 2)) / max(height, 1)
    bbox_area_ratio = (bbox_width * bbox_height) / max(width * height, 1)
    reasons += [
        f"center_offset=({center_offset_x:.2f},{center_offset_y:.2f})",
        f"bbox_area={bbox_area_ratio:.2f}",
    ]

    if strict_single and (lower_x_group_count >= 3 or x_group_count >= 4 or repeated_component_count >= 2):
        return _validation_result(False, -95, reasons + ["reject_repeated_tools_in_image"], estimated_object_count)

    if not strict_single and (lower_x_group_count >= 5 or large_component_count >= 4):
        return _validation_result(False, -80, reasons + ["reject_repeated_tools_in_image"], estimated_object_count)

    if strict_single and (component_count >= 3 or x_group_count >= 3):
        return _validation_result(False, -70, reasons + ["reject_multiple_objects"], estimated_object_count)

    if strict_single and component_count >= 2 and x_group_count >= 2:
        return _validation_result(False, -55, reasons + ["reject_separate_objects"], estimated_object_count)

    if strict_single and touches_edges:
        return _validation_result(False, -35, reasons + ["reject_cropped_object"], estimated_object_count)

    if strict_single and (center_offset_x > 0.28 or center_offset_y > 0.28):
        reasons.append("off_center_allowed")

    return _validation_result(
        True,
        18 if strict_single else 8,
        reasons + text_only_check["reasons"] + diagram_check["reasons"] + background_check["reasons"] + noise_check["reasons"] + ["single_object_image_ok"],
        max(1, estimated_object_count),
    )


def validate_single_object_image(image_url: str, tool_name_en: str = "", tool_name_vi: str = "", tool_type: str = "") -> dict:
    profile = _profile_for(tool_name_en, tool_name_vi, tool_type)
    validation = _validate_single_object_image(image_url, profile)
    reason = "; ".join(validation.get("reasons", []))
    return {
        "isValid": bool(validation.get("ok")),
        "is_valid": bool(validation.get("ok")),
        "reason": reason,
        "objectCount": validation.get("object_count", 0),
        "object_count": validation.get("object_count", 0),
    }


def _apply_image_validation(candidates: list[dict], profile: dict) -> list[dict]:
    validated = []
    for index, candidate in enumerate(candidates[:MAX_VALIDATED_CANDIDATES]):
        validation = _validate_single_object_image(candidate["url"], profile)
        candidate["score"] += validation["delta"]
        candidate["reasons"] = candidate["reasons"] + validation["reasons"]
        candidate["image_validation_ok"] = validation["ok"]
        if validation["ok"] or not REQUIRE_SINGLE_OBJECT_IMAGE_VALIDATION:
            validated.append(candidate)
        print(
            f"[ImageSearch] visual_check#{index + 1} ok={validation['ok']} "
            f"object_count={validation.get('object_count', 0)} "
            f"delta={validation['delta']} reasons={validation['reasons']} url={candidate['url']}"
        )
        print(f"[ToolImage] validation: {validation}")

    if REQUIRE_SINGLE_OBJECT_IMAGE_VALIDATION:
        return validated
    return candidates


def _search_google_images(query: str) -> list[dict]:
    if GoogleSearch is None:
        raise RuntimeError("serpapi package is not installed in this Python environment")
    if not SERPAPI_KEY:
        raise RuntimeError("SERPAPI_KEY is missing")
    params = {
        "engine": "google_images",
        "q": query,
        "api_key": SERPAPI_KEY,
        "num": MAX_IMAGE_RESULTS,
        "ijn": 0,
        "safe": "active",
    }
    search = GoogleSearch(params)
    results = search.get_dict()
    return results.get("images_results", []) or []


def _safe_filename(value: str = "tool") -> str:
    normalized = normalize_text(value)
    safe = re.sub(r"[^a-z0-9_-]+", "_", normalized).strip("_")
    return safe[:80] or "tool"


def _lanczos_filter():
    return getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)


def _static_url_to_local_path(image_url: str = ""):
    if not image_url or not image_url.startswith("/static/"):
        return None
    relative = image_url.lstrip("/").replace("/", os.sep)
    return os.path.abspath(os.path.join("app", relative))


def _load_image_for_cleaning(image_url: str):
    if not image_url:
        return None

    if image_url.startswith("/static/"):
        local_path = _static_url_to_local_path(image_url)
        if local_path and os.path.exists(local_path):
            return Image.open(local_path)
        raise FileNotFoundError(local_path or image_url)

    if os.path.exists(image_url):
        return Image.open(image_url)

    response = requests.get(
        image_url,
        timeout=IMAGE_FETCH_TIMEOUT,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    response.raise_for_status()
    return Image.open(io.BytesIO(response.content))


def _read_image_bytes(image_url: str):
    if not image_url:
        return None
    if image_url.startswith("/static/"):
        local_path = _static_url_to_local_path(image_url)
        if local_path and os.path.exists(local_path):
            with open(local_path, "rb") as file:
                return file.read()
        return None
    if os.path.exists(image_url):
        with open(image_url, "rb") as file:
            return file.read()
    response = requests.get(
        image_url,
        timeout=IMAGE_FETCH_TIMEOUT,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    response.raise_for_status()
    return response.content


def compute_image_hash(image_url: str):
    data = _read_image_bytes(image_url)
    if not data:
        return None
    return hashlib.sha256(data).hexdigest()


def _resize_for_cleaning(image, max_side=1000):
    image = image.convert("RGBA")
    width, height = image.size
    largest = max(width, height)
    if largest > max_side:
        scale = max_side / largest
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), _lanczos_filter())
    return image


def _is_glass_like_tool(tool_name_en: str = "", tool_type: str = "") -> bool:
    text_value = normalize_text(f"{tool_type} {tool_name_en}")
    return any(hint in text_value for hint in GLASS_LIKE_TOOL_HINTS)


def _build_clean_mask(image, glass_like: bool):
    image = _resize_for_cleaning(image)
    pixels = image.load()
    width, height = image.size
    bg = _estimate_background_rgb(pixels, width, height)
    mask = Image.new("L", (width, height), 0)
    mask_pixels = mask.load()

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < 32:
                continue
            brightness = (r + g + b) / 3
            spread = max(r, g, b) - min(r, g, b)
            bg_distance = abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2])

            if glass_like:
                # Transparent glass is mostly faint neutral edges. Light colored
                # watermark/logo shapes are deliberately excluded here.
                colored_watermark = spread > 45 and brightness > 145
                neutral_edge = spread <= 55 and 70 <= brightness < 248 and bg_distance > 18
                dark_edge = brightness < 170 and bg_distance > 20
                keep = (neutral_edge or dark_edge) and not colored_watermark
            else:
                near_white = brightness > 245 and spread < 26
                keep = not near_white and bg_distance > 30

            if keep:
                mask_pixels[x, y] = 255

    if ImageFilter is not None:
        mask = mask.filter(ImageFilter.MaxFilter(3))
    return image, _filter_clean_mask_components(mask)


def _filter_clean_mask_components(mask_image):
    width, height = mask_image.size
    source_pixels = mask_image.load()
    bool_mask = [[source_pixels[x, y] > 0 for x in range(width)] for y in range(height)]
    components = _all_components(bool_mask, width, height, min_area=max(8, int(width * height * 0.00003)))
    components = [
        component for component in components
        if not _is_border_like_component(component, width, height)
    ]
    if not components:
        return mask_image

    largest_area = max(component["area"] for component in components)
    min_area = max(12, int(largest_area * 0.035))
    selected = [component for component in components if component["area"] >= min_area]
    selected.sort(key=lambda item: item["area"], reverse=True)
    selected = selected[:10]

    filtered = Image.new("L", (width, height), 0)
    filtered_pixels = filtered.load()
    selected_boxes = [component["bbox"] for component in selected]
    for y in range(height):
        for x in range(width):
            if not bool_mask[y][x]:
                continue
            if any(min_x <= x <= max_x and min_y <= y <= max_y for min_x, min_y, max_x, max_y in selected_boxes):
                filtered_pixels[x, y] = 255
    return filtered


def _is_border_like_component(component, width, height):
    min_x, min_y, max_x, max_y = component["bbox"]
    box_width = max_x - min_x + 1
    box_height = max_y - min_y + 1
    touches_edge = min_x <= 1 or min_y <= 1 or max_x >= width - 2 or max_y >= height - 2
    spans_image = box_width > width * 0.75 or box_height > height * 0.75
    thin_line = box_width <= max(5, width * 0.015) or box_height <= max(5, height * 0.015)
    return touches_edge and spans_image and thin_line


def _expanded_pil_bbox(bbox, width, height, margin_ratio=0.10):
    left, top, right, bottom = bbox
    margin_x = max(12, int(width * margin_ratio))
    margin_y = max(12, int(height * margin_ratio))
    return (
        max(0, left - margin_x),
        max(0, top - margin_y),
        min(width, right + margin_x),
        min(height, bottom + margin_y),
    )


def _compose_clean_white_image(image, mask, glass_like: bool):
    bbox = mask.getbbox()
    if not bbox:
        return None

    width, height = image.size
    bbox = _expanded_pil_bbox(bbox, width, height)
    source_crop = image.crop(bbox).convert("RGBA")
    mask_crop = mask.crop(bbox)
    crop_width, crop_height = source_crop.size
    clean_crop = Image.new("RGB", (crop_width, crop_height), (255, 255, 255))

    source_pixels = source_crop.load()
    mask_pixels = mask_crop.load()
    clean_pixels = clean_crop.load()
    for y in range(crop_height):
        for x in range(crop_width):
            if mask_pixels[x, y] <= 0:
                continue
            r, g, b, a = source_pixels[x, y]
            if a < 32:
                continue
            if glass_like:
                brightness = (r + g + b) / 3
                spread = max(r, g, b) - min(r, g, b)
                if spread <= 60 and brightness > 130:
                    r = max(0, int(r * 0.68))
                    g = max(0, int(g * 0.68))
                    b = max(0, int(b * 0.68))
            clean_pixels[x, y] = (r, g, b)

    canvas_size = CLEANED_IMAGE_CANVAS_SIZE
    margin = int(canvas_size * 0.10)
    usable = canvas_size - margin * 2
    scale = min(usable / max(crop_width, 1), usable / max(crop_height, 1))
    resized_size = (max(1, int(crop_width * scale)), max(1, int(crop_height * scale)))
    clean_crop = clean_crop.resize(resized_size, _lanczos_filter())

    canvas = Image.new("RGB", (canvas_size, canvas_size), (255, 255, 255))
    paste_at = ((canvas_size - resized_size[0]) // 2, (canvas_size - resized_size[1]) // 2)
    canvas.paste(clean_crop, paste_at)
    return canvas


def clean_tool_image_for_3d(image_url: str, tool_name_en: str = "", tool_id=None, tool_type: str = ""):
    """Create a clean single-object white-background image before image-to-3D."""
    if not image_url:
        return None
    if image_url.startswith(CLEANED_IMAGE_URL_PREFIX):
        return image_url
    if Image is None:
        print("[ImageClean] PIL is unavailable; using original image")
        return image_url

    try:
        image = _load_image_for_cleaning(image_url)
        glass_like = _is_glass_like_tool(tool_name_en, tool_type)
        image, mask = _build_clean_mask(image, glass_like)
        cleaned = _compose_clean_white_image(image, mask, glass_like)
        if cleaned is None:
            print(f"[ImageClean] no foreground found; using original image: {image_url}")
            return image_url

        output = io.BytesIO()
        cleaned.save(output, format="PNG")
        cleaned_bytes = output.getvalue()
        image_hash = hashlib.sha256(cleaned_bytes).hexdigest()
        os.makedirs(CLEANED_IMAGE_DIR, exist_ok=True)
        suffix = str(tool_id or int(time.time()))[:8]
        filename = f"{_safe_filename(tool_name_en)}_{suffix}_{image_hash[:16]}.png"
        output_path = os.path.join(CLEANED_IMAGE_DIR, filename)
        with open(output_path, "wb") as file:
            file.write(cleaned_bytes)
        cleaned_url = f"{CLEANED_IMAGE_URL_PREFIX}/{filename}"
        print(f"[ImageClean] saved cleaned image: {cleaned_url} source={image_url}")
        return cleaned_url
    except Exception as exc:
        print(f"[ImageClean] failed for {image_url}: {exc}")
        return image_url


def search_tool_image(tool_name_en: str, tool_name_vi: str = "", tool_type: str = "", subject_code: str = "general"):
    profile = _profile_for(tool_name_en, tool_name_vi, tool_type)
    seen_urls = set()
    canonical = profile.get("canonical") or tool_name_en

    print(f"[ImageSearch] tool={tool_name_en} type={tool_type} subject={subject_code}")
    print(f"[ToolImage] tool name: {tool_name_vi or tool_name_en}")
    print(f"[ToolImage] prompt: {_single_object_prompt(canonical)}")
    print(f"[ToolImage] negative prompt: {NEGATIVE_IMAGE_PROMPT}")

    for attempt, query in enumerate(_build_queries(tool_name_en, tool_name_vi, tool_type, subject_code)[:MAX_IMAGE_SEARCH_ATTEMPTS], start=1):
        candidates = []
        print(f"[ToolImage] attempt: {attempt}")
        print(f"[ImageSearch] query: {query}")
        try:
            results = _search_google_images(query)
        except Exception as exc:
            print(f"[ImageSearch] search failed: {exc}")
            continue

        for result in results:
            url = result.get("original") or result.get("thumbnail")
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            document_noise, document_reasons = _candidate_document_noise(result)
            if document_noise:
                print(f"[ImageSearch] skip document-like image reasons={document_reasons} url={url}")
                continue
            score, reasons = _score_image_result(result, profile, subject_code)
            candidates.append({
                "url": url,
                "score": score,
                "metadata_score": score,
                "title": result.get("title", ""),
                "source": result.get("source", ""),
                "reasons": reasons,
            })

        candidates.sort(key=lambda item: item["score"], reverse=True)
        metadata_candidates = list(candidates)
        validated_candidates = _apply_image_validation(candidates, profile)
        validated_candidates.sort(key=lambda item: item["score"], reverse=True)
        for index, item in enumerate(validated_candidates[:5], start=1):
            print(
                f"[ImageSearch] candidate#{index} score={item['score']} "
                f"source={item['source']} title={item['title']} reasons={item['reasons']} url={item['url']}"
            )

        if validated_candidates:
            best = validated_candidates[0]
            if (
                best["score"] >= IMAGE_SCORE_THRESHOLD or
                (best.get("image_validation_ok") and best["score"] >= IMAGE_VISUAL_SCORE_THRESHOLD)
            ):
                print(f"[ImageSearch] selected score={best['score']} url={best['url']}")
                print(f"[ToolImage] accepted image: {best['url']}")
                return best["url"]

        metadata_fallback = _metadata_fallback_candidate(metadata_candidates)
        if metadata_fallback:
            print(
                f"[ImageSearch] selected metadata_fallback score={metadata_fallback['metadata_score']} "
                f"source={metadata_fallback['source']} title={metadata_fallback['title']} "
                f"reasons={metadata_fallback['reasons']} url={metadata_fallback['url']}"
            )
            print(f"[ToolImage] accepted image: {metadata_fallback['url']}")
            return metadata_fallback["url"]

        validation_log = validated_candidates[0] if validated_candidates else {"reason": "no_valid_single_object_candidate"}
        print(f"[ToolImage] validation: {validation_log}")
        print(f"[ImageValidation] rejected: no single-object image accepted on attempt {attempt}")

    print(f"[ImageSearch] no confident single-object image for {tool_name_en}; avoid using wrong image")
    print(f"[ToolImage] {SINGLE_IMAGE_FAILURE_MESSAGE}")
    return None


def update_missing_images(engine):
    with Session(engine) as session:
        ensure_tools_metadata_columns(session)
        session.commit()
        statement = select(Tools).where(Tools.image_2d_url == None)
        pending_tools = session.exec(statement).all()

        for tool in pending_tools:
            print(f"Dang tim anh cho: {tool.name_tool_en}")
            url = search_tool_image(tool.name_tool_en, tool.name_tool_vi, tool.tool_type, tool.subject_type)
            if url:
                tool.image_2d_url = url
                session.add(tool)
                print(f"Da tim thay: {url}")

        session.commit()
