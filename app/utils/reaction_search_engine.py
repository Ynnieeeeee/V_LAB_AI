import json
from pathlib import Path

import faiss
import numpy as np

from sentence_transformers import (
    SentenceTransformer
)

# =========================================================
# AI CHEMISTRY SEARCH ENGINE (IMPROVED)
# =========================================================
#
# IMPROVEMENTS:
#
# ✅ Weighted semantic scoring
# ✅ Reaction-type priority
# ✅ Effect-based ranking
# ✅ Better Vietnamese chemistry retrieval
# ✅ Reduced noisy feature matching
# ✅ Better gameplay prediction
#
# =========================================================

# =========================================================
# LOAD MODEL
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
# LOAD DATASET
# =========================================================

BASE_DIR = Path(__file__).resolve().parent

INPUT_JSON = (
    BASE_DIR /
    "embedded_reactions.json"
)

print("=" * 60)
print("LOADING EMBEDDED REACTIONS...")

with open(
    INPUT_JSON,
    "r",
    encoding="utf-8"
) as f:

    reactions = json.load(f)

print("TOTAL REACTIONS:",
      len(reactions))

# =========================================================
# BUILD FAISS INDEX
# =========================================================

print("=" * 60)
print("BUILDING VECTOR DATABASE...")

embeddings = np.array([

    reaction["embedding"]

    for reaction in reactions

]).astype("float32")

dimension = embeddings.shape[1]

# Cosine similarity
index = faiss.IndexFlatIP(
    dimension
)

index.add(embeddings)

print("FAISS READY")
print("TOTAL VECTORS:",
      index.ntotal)

# =========================================================
# REACTION TYPE KEYWORDS
# =========================================================

REACTION_TYPE_KEYWORDS = {

    "combustion": [
        "cháy",
        "đốt",
        "burn",
        "combustion",
        "flammable",
        "lửa"
    ],

    "explosive": [
        "nổ",
        "explosion",
        "explosive",
        "boom"
    ],

    "gas_evolution": [
        "khí",
        "gas",
        "bọt",
        "sủi"
    ],

    "neutralization": [
        "trung hòa",
        "acid",
        "base",
        "axit",
        "bazơ"
    ],

    "precipitation": [
        "kết tủa",
        "precipitate"
    ],

    "sulfur_reaction": [
        "sulfur",
        "lưu huỳnh",
        "sunfua"
    ]
}

# =========================================================
# QUERY -> EMBEDDING
# =========================================================

def embed_query(query):

    embedding = model.encode(

        [query],

        normalize_embeddings=True
    )

    return np.array(
        embedding
    ).astype("float32")

# =========================================================
# DETECT QUERY INTENT
# =========================================================

def detect_query_intent(query):

    query_lower = query.lower()

    detected_types = []

    for reaction_type, keywords in \
        REACTION_TYPE_KEYWORDS.items():

        for keyword in keywords:

            if keyword in query_lower:

                detected_types.append(
                    reaction_type
                )

                break

    return detected_types

# =========================================================
# BONUS SCORING
# =========================================================

def compute_bonus_score(
    query,
    reaction
):

    query_lower = query.lower()

    analysis = reaction["analysis"]

    reaction_types = analysis.get(
        "reaction_types",
        []
    )

    bonus = 0.0

    # =====================================================
    # REACTION TYPE MATCH BONUS
    # =====================================================

    detected_types = detect_query_intent(
        query
    )

    for detected in detected_types:

        if detected in reaction_types:

            bonus += 0.25

    # =====================================================
    # FIRE BONUS
    # =====================================================

    if (
        "cháy" in query_lower or
        "lửa" in query_lower or
        "burn" in query_lower
    ):

        bonus += (
            analysis.get("fire", 0)
            * 0.2
        )

    # =====================================================
    # EXPLOSION BONUS
    # =====================================================

    if (
        "nổ" in query_lower or
        "explosion" in query_lower
    ):

        bonus += (
            analysis.get(
                "explosion",
                0
            ) * 0.25
        )

    # =====================================================
    # GAS BONUS
    # =====================================================

    if (
        "khí" in query_lower or
        "gas" in query_lower
    ):

        bonus += (
            analysis.get("gas", 0)
            * 0.2
        )

    # =====================================================
    # SMOKE BONUS
    # =====================================================

    if (
        "khói" in query_lower or
        "smoke" in query_lower
    ):

        bonus += (
            analysis.get("smoke", 0)
            * 0.15
        )

    return bonus

# =========================================================
# SEARCH ENGINE
# =========================================================

def search_reactions(
    query,
    top_k=5
):

    # =====================================================
    # VECTOR SEARCH
    # =====================================================

    query_embedding = embed_query(
        query
    )

    scores, indices = index.search(

        query_embedding,

        50
    )

    # =====================================================
    # RE-RANK RESULTS
    # =====================================================

    reranked = []

    for base_score, idx in zip(
        scores[0],
        indices[0]
    ):

        reaction = reactions[idx]

        bonus = compute_bonus_score(
            query,
            reaction
        )

        final_score = (
            float(base_score)
            + bonus
        )

        reranked.append({

            "score":
                final_score,

            "base_score":
                float(base_score),

            "bonus":
                bonus,

            "reaction":
                reaction
        })

    # =====================================================
    # SORT
    # =====================================================

    reranked.sort(

        key=lambda x: x["score"],

        reverse=True
    )

    # =====================================================
    # FINAL RESULTS
    # =====================================================

    results = []

    for item in reranked[:top_k]:

        reaction = item["reaction"]

        results.append({

            "score":
                round(item["score"], 3),

            "base_score":
                round(item["base_score"], 3),

            "bonus":
                round(item["bonus"], 3),

            "reaction_id":
                reaction["reaction_id"],

            "semantic_text":
                reaction["semantic_text"],

            "analysis":
                reaction["analysis"],

            "reactants":
                reaction["reactants"],

            "products":
                reaction["products"]
        })

    return results

# =========================================================
# PREDICT GAMEPLAY EFFECTS
# =========================================================

def predict_gameplay_effects(results):

    if len(results) == 0:

        return None

    total_weight = 0.0

    fire = 0.0
    smoke = 0.0
    gas = 0.0
    explosion = 0.0
    heat = 0.0
    toxicity = 0.0
    corrosive = 0.0

    reaction_types = []

    for result in results:

        weight = result["score"]

        analysis = result["analysis"]

        total_weight += weight

        fire += (
            analysis.get("fire", 0)
            * weight
        )

        smoke += (
            analysis.get("smoke", 0)
            * weight
        )

        gas += (
            analysis.get("gas", 0)
            * weight
        )

        explosion += (
            analysis.get(
                "explosion",
                0
            ) * weight
        )

        heat += (
            analysis.get("heat", 0)
            * weight
        )

        toxicity += (
            analysis.get(
                "toxicity",
                0
            ) * weight
        )

        corrosive += (
            analysis.get(
                "corrosive",
                0
            ) * weight
        )

        reaction_types.extend(

            analysis.get(
                "reaction_types",
                []
            )
        )

    predicted = {

        "fire":
            round(fire / total_weight, 2),

        "smoke":
            round(smoke / total_weight, 2),

        "gas":
            round(gas / total_weight, 2),

        "explosion":
            round(explosion / total_weight, 2),

        "heat":
            round(heat / total_weight, 2),

        "toxicity":
            round(toxicity / total_weight, 2),

        "corrosive":
            round(corrosive / total_weight, 2),

        "reaction_types":
            list(set(reaction_types))
    }

    return predicted

# =========================================================
# PRINT RESULTS
# =========================================================

def print_results(results):

    print("\n")
    print("=" * 60)
    print("SEARCH RESULTS")
    print("=" * 60)

    for i, result in enumerate(results):

        analysis = result["analysis"]

        print(f"\n#{i+1}")

        print(
            "FINAL SCORE:",
            result["score"]
        )

        print(
            "BASE SCORE:",
            result["base_score"]
        )

        print(
            "BONUS:",
            result["bonus"]
        )

        print(
            "REACTION ID:",
            result["reaction_id"]
        )

        print(
            "REACTION TYPES:",
            analysis.get(
                "reaction_types",
                []
            )
        )

        print(
            "FIRE:",
            analysis.get("fire", 0)
        )

        print(
            "SMOKE:",
            analysis.get("smoke", 0)
        )

        print(
            "GAS:",
            analysis.get("gas", 0)
        )

        print(
            "EXPLOSION:",
            analysis.get(
                "explosion",
                0
            )
        )

        print(
            "HEAT:",
            analysis.get("heat", 0)
        )

        print("\nSEMANTIC TEXT:")
        print(
            result["semantic_text"]
        )

# =========================================================
# MAIN
# =========================================================

if __name__ == "__main__":

    print("\n")
    print("=" * 60)
    print("AI CHEMISTRY SEARCH ENGINE READY")
    print("Type 'exit' to quit.")
    print("=" * 60)

    while True:

        print("\n")

        query = input(
            "CHEMISTRY QUERY: "
        )

        if query.lower() == "exit":

            print("GOODBYE")
            break

        # =================================================
        # SEARCH
        # =================================================

        results = search_reactions(

            query=query,

            top_k=5
        )

        # =================================================
        # PRINT
        # =================================================

        print_results(results)

        # =================================================
        # GAMEPLAY PREDICTION
        # =================================================

        predicted = predict_gameplay_effects(
            results
        )

        print("\n")
        print("=" * 60)
        print("PREDICTED GAMEPLAY EFFECTS")
        print("=" * 60)

        print(json.dumps(
            predicted,
            indent=2,
            ensure_ascii=False
        ))