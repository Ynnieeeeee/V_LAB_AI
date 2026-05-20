import json
from pathlib import Path

def has_feature(molecules, feature_name):

    return any(
        mol["features"].get(feature_name, 0)
        for mol in molecules
    )


def feature_score(molecules, feature_name):

    values = [
        mol["features"].get(feature_name, 0)
        for mol in molecules
    ]

    if len(values) == 0:
        return 0.0

    return max(values)


def clamp(value, min_value=0.0, max_value=1.0):

    return max(min_value, min(value, max_value))


def analyze_reaction(reactants, products):

    analysis = {

        "fire": 0.0,
        "smoke": 0.0,
        "gas": 0.0,
        "foam": 0.0,
        "light": 0.0,
        "spark": 0.0,
        "explosion": 0.0,
        "precipitate": 0.0,

        "heat": 0.0,
        "cold": 0.0,

        "toxicity": 0.0,
        "corrosive": 0.0,
        "volatility": 0.0,
        "reactivity": 0.0,

        "danger_level": 0.0,
        "stable": True,

        "reaction_types": []
    }

    acidic = has_feature(
        reactants,
        "carboxylic_acid"
    )

    basic = has_feature(
        reactants,
        "amine"
    )

    flammable = (
        has_feature(reactants, "alcohol")
        or has_feature(reactants, "alkene")
        or has_feature(reactants, "alkyne")
        or has_feature(reactants, "benzene")
    )

    oxidizer = (
        has_feature(reactants, "peroxide")
        or has_feature(reactants, "nitro")
        or has_feature(reactants, "oxidizer")
    )

    explosive = (
        has_feature(reactants, "explosive_nitro")
        or has_feature(reactants, "perchlorate")
    )

    sulfur = (
        has_feature(reactants, "thiol")
        or has_feature(reactants, "sulfide")
    )

    halogen = has_feature(
        reactants,
        "halogen"
    )

    carbonate = has_feature(
        reactants,
        "carbonate"
    )

    aromatic = has_feature(
        reactants,
        "benzene"
    )

    polymerizable = (
        has_feature(reactants, "vinyl")
        or has_feature(reactants, "acrylate")
    )

    metal = has_feature(
        reactants,
        "organometallic"
    )

    analysis["volatility"] = clamp(
        (
            feature_score(reactants, "ether") * 0.6
            + feature_score(reactants, "alcohol") * 0.4
        )
    )

    analysis["toxicity"] = clamp(
        (
            feature_score(reactants, "halogen") * 0.5
            + feature_score(reactants, "nitro") * 0.4
            + feature_score(reactants, "sulfonic_acid") * 0.3
        )
    )

    analysis["corrosive"] = clamp(
        (
            feature_score(reactants, "carboxylic_acid") * 0.7
            + feature_score(reactants, "acid_chloride") * 1.0
        )
    )

    analysis["reactivity"] = clamp(
        (
            feature_score(reactants, "alkene") * 0.3
            + feature_score(reactants, "epoxide") * 0.6
            + feature_score(reactants, "organometallic") * 0.9
        )
    )

    if acidic and basic:

        analysis["heat"] += 0.7
        analysis["foam"] += 0.2

        analysis["reaction_types"].append(
            "neutralization"
        )
    
    if flammable and oxidizer:

        analysis["fire"] += 0.9
        analysis["heat"] += 0.9
        analysis["smoke"] += 0.5
        analysis["light"] += 0.4

        analysis["reaction_types"].append(
            "combustion"
        )

    if explosive and oxidizer:

        analysis["explosion"] += 1.0
        analysis["fire"] += 0.8
        analysis["smoke"] += 0.9
        analysis["shockwave"] = 1.0

        analysis["danger_level"] += 1.0

        analysis["stable"] = False

        analysis["reaction_types"].append(
            "explosive"
        )

    if acidic and carbonate:

        analysis["gas"] += 0.9
        analysis["foam"] += 0.7

        analysis["reaction_types"].append(
            "gas_evolution"
        )

    if sulfur:

        analysis["gas"] += 0.4
        analysis["smoke"] += 0.6
        analysis["toxicity"] += 0.5

        analysis["reaction_types"].append(
            "sulfur_reaction"
        )

    if halogen and analysis["fire"] > 0:

        analysis["smoke"] += 0.7
        analysis["toxicity"] += 0.6

        analysis["reaction_types"].append(
            "toxic_combustion"
        )

    if metal and acidic:

        analysis["gas"] += 0.8
        analysis["heat"] += 0.5

        analysis["reaction_types"].append(
            "metal_acid_reaction"
        )

    if polymerizable:

        analysis["heat"] += 0.4
        analysis["foam"] += 0.5

        analysis["reaction_types"].append(
            "polymerization"
        )

    if aromatic and analysis["fire"] > 0:

        analysis["smoke"] += 0.8

        analysis["reaction_types"].append(
            "aromatic_combustion"
        )

    if len(products) > len(reactants):

        analysis["precipitate"] += 0.5

        analysis["reaction_types"].append(
            "precipitation"
        )

    for key, value in analysis.items():

        if isinstance(value, float):

            analysis[key] = round(
                clamp(value),
                2
            )

    analysis["danger_level"] = round(
        clamp(
            (
                analysis["fire"] * 0.3
                + analysis["explosion"] * 0.5
                + analysis["toxicity"] * 0.2
            )
        ),
        2
    )

    return analysis


def analyze_dataset(input_json, output_json):

    with open(input_json, "r", encoding="utf-8") as f:

        data = json.load(f)

    analyzed_data = []

    for reaction in data:

        reactants = reaction["reactants"]
        products = reaction["products"]

        analysis = analyze_reaction(
            reactants,
            products
        )

        reaction["analysis"] = analysis

        analyzed_data.append(reaction)

    with open(output_json, "w", encoding="utf-8") as f:

        json.dump(
            analyzed_data,
            f,
            indent=2,
            ensure_ascii=False
        )

    print("=" * 50)
    print("REACTION ANALYSIS COMPLETE")
    print("Total reactions:", len(analyzed_data))
    print("Saved:", output_json)

if __name__ == "__main__":

    BASE_DIR = Path(__file__).resolve().parent

    INPUT_JSON = BASE_DIR / "processed_reactions.json"

    OUTPUT_JSON = BASE_DIR / "analyzed_reactions.json"

    analyze_dataset(
        INPUT_JSON,
        OUTPUT_JSON
    )