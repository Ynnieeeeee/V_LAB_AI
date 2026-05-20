import json
from pathlib import Path

from sentence_transformers import SentenceTransformer

# =========================================================
# VIETNAMESE AI CHEMISTRY EMBEDDING GENERATOR
# =========================================================
#
# INPUT:
# analyzed_reactions.json
#
# OUTPUT:
# embedded_reactions.json
#
# PIPELINE:
#
# chemistry data
# -> semantic vietnamese text
# -> embedding vectors
# -> retrieval-ready dataset
#
# =========================================================

# =========================================================
# LOAD EMBEDDING MODEL
# =========================================================

print("=" * 60)
print("LOADING EMBEDDING MODEL...")

MODEL_NAME = "BAAI/bge-small-en-v1.5"

model = SentenceTransformer(
    MODEL_NAME
)

print("MODEL LOADED")
print("MODEL:", MODEL_NAME)

# =========================================================
# FEATURE TRANSLATIONS
# =========================================================

FEATURE_TRANSLATIONS = {

    # ORGANIC
    "alcohol": "ancol",
    "carboxylic_acid": "axit cacboxylic",
    "aldehyde": "andehit",
    "ketone": "xeton",
    "ether": "ete",
    "ester": "este",
    "phenol": "phenol",
    "amine": "amin",
    "amide": "amit",
    "alkene": "anken",
    "alkyne": "ankin",
    "benzene": "benzen",

    # HALOGEN
    "halogen": "halogen",

    # NITROGEN
    "nitro": "nitro",
    "nitrile": "nitrile",
    "imine": "imin",
    "azo": "azo",

    # SULFUR
    "thiol": "thiol",
    "sulfide": "sunfua",
    "sulfoxide": "sunfoxit",
    "sulfone": "sunfon",
    "sulfonic_acid": "axit sunfonic",

    # PHOSPHORUS
    "phosphate": "phosphate",
    "phosphonate": "phosphonate",

    # SPECIAL
    "peroxide": "peroxide",
    "epoxide": "epoxide",

    # REACTIVITY
    "flammable": "dễ cháy",
    "acidic": "có tính axit",
    "basic": "có tính bazơ",
    "reactive": "phản ứng mạnh"
}

# =========================================================
# REACTION TYPE TRANSLATIONS
# =========================================================

REACTION_TYPE_TRANSLATIONS = {

    "combustion":
        "phản ứng cháy",

    "neutralization":
        "phản ứng trung hòa",

    "gas_evolution":
        "phản ứng tạo khí",

    "explosive":
        "phản ứng nổ",

    "polymerization":
        "phản ứng trùng hợp",

    "sulfur_reaction":
        "phản ứng lưu huỳnh",

    "metal_acid_reaction":
        "phản ứng kim loại với axit",

    "aromatic_combustion":
        "cháy hợp chất thơm",

    "toxic_combustion":
        "cháy tạo khí độc",

    "precipitation":
        "phản ứng kết tủa"
}

# =========================================================
# EFFECT TRANSLATIONS
# =========================================================

EFFECT_TRANSLATIONS = {

    "fire": "lửa",
    "smoke": "khói",
    "gas": "khí",
    "explosion": "nổ",
    "heat": "nhiệt",
    "cold": "lạnh",
    "foam": "bọt",
    "light": "ánh sáng",
    "spark": "tia lửa",
    "toxicity": "độc tính",
    "corrosive": "ăn mòn",
    "reactivity": "độ phản ứng",
    "volatility": "bay hơi"
}

# =========================================================
# UTILITIES
# =========================================================

def normalize_feature_name(name):

    return FEATURE_TRANSLATIONS.get(
        name,
        name.replace("_", " ")
    )

def normalize_reaction_type(name):

    return REACTION_TYPE_TRANSLATIONS.get(
        name,
        name.replace("_", " ")
    )

# =========================================================
# EXTRACT IMPORTANT FEATURES
# =========================================================

def extract_active_features(reactants):

    ignored_keys = {

        "molecular_weight",
        "logp",
        "num_atoms"
    }

    active_features = set()

    for molecule in reactants:

        features = molecule["features"]

        for key, value in features.items():

            if key in ignored_keys:
                continue

            if value == 1:

                active_features.add(
                    normalize_feature_name(key)
                )

    return list(active_features)

# =========================================================
# BUILD EFFECT DESCRIPTION
# =========================================================

def build_effect_description(analysis):

    effect_parts = []

    for key, vi_name in EFFECT_TRANSLATIONS.items():

        value = analysis.get(key, 0)

        if value > 0:

            effect_parts.append(
                f"{vi_name} mức {value}"
            )

    return ", ".join(effect_parts)

# =========================================================
# REACTION -> SEMANTIC TEXT
# =========================================================

def reaction_to_text(reaction):

    reactants = reaction["reactants"]

    analysis = reaction["analysis"]

    # =====================================================
    # FEATURES
    # =====================================================

    active_features = extract_active_features(
        reactants
    )

    # =====================================================
    # REACTION TYPES
    # =====================================================

    reaction_types = analysis.get(
        "reaction_types",
        []
    )

    translated_types = [

        normalize_reaction_type(t)

        for t in reaction_types
    ]

    # =====================================================
    # EFFECTS
    # =====================================================

    effects_text = build_effect_description(
        analysis
    )

    # =====================================================
    # DANGER
    # =====================================================

    danger_level = analysis.get(
        "danger_level",
        0
    )

    stable = analysis.get(
        "stable",
        True
    )

    stability_text = (
        "ổn định"
        if stable
        else "không ổn định"
    )

    # =====================================================
    # BUILD SEMANTIC TEXT
    # =====================================================

    semantic_text = f"""
    Phản ứng hóa học chứa:
    {", ".join(active_features)}.

    Loại phản ứng:
    {", ".join(translated_types)}.

    Hiệu ứng sinh ra:
    {effects_text}.

    Mức nguy hiểm:
    {danger_level}.

    Độ ổn định:
    {stability_text}.
    """

    return semantic_text.strip()

# =========================================================
# GENERATE EMBEDDINGS
# =========================================================

def generate_embeddings(data):

    print("=" * 60)
    print("GENERATING SEMANTIC TEXTS...")

    texts = []

    for reaction in data:

        text = reaction_to_text(
            reaction
        )

        texts.append(text)

    print("TOTAL TEXTS:", len(texts))

    print("=" * 60)
    print("GENERATING EMBEDDINGS...")

    embeddings = model.encode(

        texts,

        batch_size=32,

        show_progress_bar=True,

        normalize_embeddings=True
    )

    print("EMBEDDING GENERATION COMPLETE")

    return embeddings, texts

# =========================================================
# SAVE OUTPUT
# =========================================================

def save_output(
    data,
    embeddings,
    texts,
    output_path
):

    print("=" * 60)
    print("SAVING EMBEDDED DATASET...")

    final_data = []

    for i, reaction in enumerate(data):

        reaction["semantic_text"] = texts[i]

        reaction["embedding"] = (

            embeddings[i].tolist()
        )

        final_data.append(reaction)

    with open(
        output_path,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            final_data,
            f,
            indent=2,
            ensure_ascii=False
        )

    print("SAVE COMPLETE")

# =========================================================
# MAIN
# =========================================================

if __name__ == "__main__":

    BASE_DIR = Path(
        __file__
    ).resolve().parent

    INPUT_JSON = (
        BASE_DIR /
        "analyzed_reactions.json"
    )

    OUTPUT_JSON = (
        BASE_DIR /
        "embedded_reactions.json"
    )

    # =====================================================
    # LOAD DATASET
    # =====================================================

    print("=" * 60)
    print("LOADING DATASET...")

    with open(
        INPUT_JSON,
        "r",
        encoding="utf-8"
    ) as f:

        data = json.load(f)

    print("TOTAL REACTIONS:",
          len(data))

    # =====================================================
    # GENERATE EMBEDDINGS
    # =====================================================

    embeddings, texts = generate_embeddings(
        data
    )

    # =====================================================
    # SAVE
    # =====================================================

    save_output(
        data,
        embeddings,
        texts,
        OUTPUT_JSON
    )

    # =====================================================
    # DONE
    # =====================================================

    print("=" * 60)
    print("DONE")
    print("OUTPUT:",
          OUTPUT_JSON)
    print("TOTAL EMBEDDINGS:",
          len(data))
    print("=" * 60)