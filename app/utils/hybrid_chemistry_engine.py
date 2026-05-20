import json
from pathlib import Path

from app.utils.chemistry_engine import (
    predict_chemical_reaction
)

# =========================================================
# HYBRID CHEMISTRY ENGINE
# =========================================================
#
# SYSTEM:
#
# 1. Deterministic chemistry rules
# 2. AI vector chemistry fallback
#
# =========================================================

# =========================================================
# SPECIAL REACTIONS
# =========================================================

SPECIAL_REACTIONS = {

    # =====================================================
    # HYDROGEN + OXYGEN
    # =====================================================

    frozenset([
        "hydrogen",
        "oxygen"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "hydrogen_combustion",

        "effects": {

            "fire": 1.0,

            "smoke": 0.2,

            "gas": 0.4,

            "explosion": 0.95,

            "heat": 1.0,

            "toxicity": 0.0,

            "corrosive": 0.0
        }
    },

    # =====================================================
    # SODIUM + WATER
    # =====================================================

    frozenset([
        "sodium",
        "water"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "alkali_metal_water",

        "effects": {

            "fire": 0.8,

            "smoke": 0.6,

            "gas": 1.0,

            "explosion": 0.9,

            "heat": 0.95,

            "toxicity": 0.0,

            "corrosive": 0.4
        }
    },

    # =====================================================
    # POTASSIUM + WATER
    # =====================================================

    frozenset([
        "potassium",
        "water"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "violent_alkali_reaction",

        "effects": {

            "fire": 1.0,

            "smoke": 0.7,

            "gas": 1.0,

            "explosion": 1.0,

            "heat": 1.0,

            "toxicity": 0.0,

            "corrosive": 0.5
        }
    },

    # =====================================================
    # ACID + BASE
    # =====================================================

    frozenset([
        "sulfuric_acid",
        "sodium_hydroxide"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "neutralization",

        "effects": {

            "fire": 0.0,

            "smoke": 0.0,

            "gas": 0.0,

            "explosion": 0.0,

            "heat": 0.7,

            "toxicity": 0.0,

            "corrosive": 0.2
        }
    },

    # =====================================================
    # ETHANOL + FIRE
    # =====================================================

    frozenset([
        "ethanol",
        "fire"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "alcohol_combustion",

        "effects": {

            "fire": 1.0,

            "smoke": 0.4,

            "gas": 0.2,

            "explosion": 0.1,

            "heat": 0.9,

            "toxicity": 0.0,

            "corrosive": 0.0
        }
    },

    # =====================================================
    # PEROXIDE + FUEL
    # =====================================================

    frozenset([
        "peroxide",
        "ethanol"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "oxidizer_combustion",

        "effects": {

            "fire": 1.0,

            "smoke": 0.9,

            "gas": 0.4,

            "explosion": 0.7,

            "heat": 1.0,

            "toxicity": 0.1,

            "corrosive": 0.0
        }
    },

    # =====================================================
    # CHLORINE + AMMONIA
    # =====================================================

    frozenset([
        "chlorine",
        "ammonia"
    ]): {

        "source": "rule_engine",

        "reaction_type":
            "toxic_gas_reaction",

        "effects": {

            "fire": 0.0,

            "smoke": 0.4,

            "gas": 1.0,

            "explosion": 0.2,

            "heat": 0.2,

            "toxicity": 1.0,

            "corrosive": 0.6
        }
    }
}

# =========================================================
# NORMALIZE CHEMICALS
# =========================================================

def normalize_chemicals(chemicals):

    normalized = []

    for chemical in chemicals:

        chemical = (
            chemical
            .lower()
            .strip()
            .replace(" ", "_")
        )

        normalized.append(
            chemical
        )

    return normalized

# =========================================================
# CHECK SPECIAL REACTIONS
# =========================================================

def check_special_reactions(
    chemicals
):

    chemicals = normalize_chemicals(
        chemicals
    )

    chemical_set = frozenset(
        chemicals
    )

    if chemical_set in SPECIAL_REACTIONS:

        return SPECIAL_REACTIONS[
            chemical_set
        ]

    return None

# =========================================================
# HYBRID PREDICTION
# =========================================================

def predict_hybrid_reaction(
    chemicals
):

    # =====================================================
    # STEP 1:
    # RULE ENGINE
    # =====================================================

    special = check_special_reactions(
        chemicals
    )

    if special is not None:

        return {

            "engine":
                "deterministic_rules",

            "chemicals":
                chemicals,

            "reaction_type":
                special[
                    "reaction_type"
                ],

            "effects":
                special[
                    "effects"
                ]
        }

    # =====================================================
    # STEP 2:
    # AI VECTOR ENGINE
    # =====================================================

    ai_result = predict_chemical_reaction(
        chemicals
    )

    return {

        "engine":
            "ai_vector_search",

        "chemicals":
            chemicals,

        "query":
            ai_result[
                "query"
            ],

        "effects":
            ai_result[
                "effects"
            ],

        "top_reactions":
            ai_result[
                "top_reactions"
            ]
    }

# =========================================================
# SAVE RESULT
# =========================================================

def save_result(
    result,
    output_path="hybrid_result.json"
):

    with open(
        output_path,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(

            result,

            f,

            indent=2,

            ensure_ascii=False
        )

# =========================================================
# PRINT RESULT
# =========================================================

def print_result(result):

    print("\n")
    print("=" * 60)

    print(
        "ENGINE:",
        result["engine"]
    )

    print("=" * 60)

    print(
        "CHEMICALS:",
        result["chemicals"]
    )

    if "reaction_type" in result:

        print(
            "REACTION TYPE:",
            result["reaction_type"]
        )

    if "query" in result:

        print(
            "AI QUERY:",
            result["query"]
        )

    print("\nEFFECTS:")

    print(json.dumps(

        result["effects"],

        indent=2,

        ensure_ascii=False
    ))

# =========================================================
# MAIN
# =========================================================

if __name__ == "__main__":

    print("=" * 60)
    print("HYBRID CHEMISTRY ENGINE")
    print("=" * 60)

    test_cases = [

        [
            "hydrogen",
            "oxygen"
        ],

        [
            "sodium",
            "water"
        ],

        [
            "sulfuric_acid",
            "sodium_hydroxide"
        ],

        [
            "ethanol",
            "peroxide"
        ],

        [
            "benzene",
            "chlorine"
        ]
    ]

    for chemicals in test_cases:

        result = predict_hybrid_reaction(
            chemicals
        )

        print_result(result)

    save_result(result)

    print("\n")
    print("=" * 60)
    print("DONE")
    print("Saved: hybrid_result.json")