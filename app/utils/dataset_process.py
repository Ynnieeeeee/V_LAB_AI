import pandas as pd
import json
from rdkit import Chem
from rdkit.Chem import Descriptors

PATTERNS = {

    # Alcohol
    "alcohol":
        Chem.MolFromSmarts("[OX2H]"),

    # Carboxylic acid
    "carboxylic_acid":
        Chem.MolFromSmarts("C(=O)[OH]"),

    # Aldehyde
    "aldehyde":
        Chem.MolFromSmarts("[CX3H1](=O)[#6]"),

    # Ketone
    "ketone":
        Chem.MolFromSmarts("[CX3](=O)[#6]"),

    # Ether
    "ether":
        Chem.MolFromSmarts("[OD2]([#6])[#6]"),

    # Ester
    "ester":
        Chem.MolFromSmarts("C(=O)O[#6]"),

    # Phenol
    "phenol":
        Chem.MolFromSmarts("c[OH]"),

    # Peroxide
    "peroxide":
        Chem.MolFromSmarts("OO"),

    # Epoxide
    "epoxide":
        Chem.MolFromSmarts("[OX2r3]"),

    # Amine
    "amine":
        Chem.MolFromSmarts("[NX3;H2,H1,H0]"),

    # Amide
    "amide":
        Chem.MolFromSmarts("C(=O)N"),

    # Nitrile
    "nitrile":
        Chem.MolFromSmarts("C#N"),

    # Nitro
    "nitro":
        Chem.MolFromSmarts("[NX3](=O)=O"),

    # Imine
    "imine":
        Chem.MolFromSmarts("C=N"),

    # Azo
    "azo":
        Chem.MolFromSmarts("N=N"),

    # Thiol
    "thiol":
        Chem.MolFromSmarts("[SH]"),

    # Sulfide
    "sulfide":
        Chem.MolFromSmarts("[#16X2]"),

    # Sulfoxide
    "sulfoxide":
        Chem.MolFromSmarts("S(=O)"),

    # Sulfone
    "sulfone":
        Chem.MolFromSmarts("S(=O)(=O)"),

    # Sulfonic acid
    "sulfonic_acid":
        Chem.MolFromSmarts("S(=O)(=O)[OH]"),

    # Phosphate
    "phosphate":
        Chem.MolFromSmarts("P(=O)(O)(O)"),

    # Phosphonate
    "phosphonate":
        Chem.MolFromSmarts("P(=O)(O)C"),

    # Alkene
    "alkene":
        Chem.MolFromSmarts("C=C"),

    # Alkyne
    "alkyne":
        Chem.MolFromSmarts("C#C"),

    # Aromatic benzene ring
    "benzene":
        Chem.MolFromSmarts("c1ccccc1"),

    # Aromatic ring
    "aromatic":
        Chem.MolFromSmarts("a"),

    # Cycloalkane
    "cycloalkane":
        Chem.MolFromSmarts("[R]"),

    # Polycyclic aromatic
    "polyaromatic":
        Chem.MolFromSmarts("c1ccc2ccccc2c1"),

    "fluoride":
        Chem.MolFromSmarts("[F]"),

    "chloride":
        Chem.MolFromSmarts("[Cl]"),

    "bromide":
        Chem.MolFromSmarts("[Br]"),

    "iodide":
        Chem.MolFromSmarts("[I]"),

    "halogen":
        Chem.MolFromSmarts("[F,Cl,Br,I]"),

    # Organometallic
    "organometallic":
        Chem.MolFromSmarts("[Li,Na,K,Mg,Ca,Fe,Zn]"),

    # Acid chloride
    "acid_chloride":
        Chem.MolFromSmarts("C(=O)Cl"),

    # Anhydride
    "anhydride":
        Chem.MolFromSmarts("C(=O)OC(=O)"),

    # Isocyanate
    "isocyanate":
        Chem.MolFromSmarts("N=C=O"),

    # Cyanate
    "cyanate":
        Chem.MolFromSmarts("O-C#N"),

    # Water
    "water":
        Chem.MolFromSmarts("[OH2]"),

    # Hydroxide
    "hydroxide":
        Chem.MolFromSmarts("[OH-]"),

    # Carbonate
    "carbonate":
        Chem.MolFromSmarts("C(=O)(O)O"),

    # Nitrate
    "nitrate":
        Chem.MolFromSmarts("[N](=O)(O)O"),

    # Sulfate
    "sulfate":
        Chem.MolFromSmarts("S(=O)(=O)(O)O"),

    # Phosphate ion
    "phosphate_ion":
        Chem.MolFromSmarts("P(=O)(O)(O)O"),

    # Oxidizer-like
    "oxidizer":
        Chem.MolFromSmarts("[O][O]"),

    # Explosive nitro
    "explosive_nitro":
        Chem.MolFromSmarts("[NX3](=O)=O"),

    # Perchlorate-like
    "perchlorate":
        Chem.MolFromSmarts("Cl(=O)(=O)(=O)O"),

    # Vinyl
    "vinyl":
        Chem.MolFromSmarts("C=C"),

    # Acrylate
    "acrylate":
        Chem.MolFromSmarts("C=CC(=O)O"),

    # Peptide
    "peptide":
        Chem.MolFromSmarts("NCC(=O)"),

    # Sugar-like
    "sugar":
        Chem.MolFromSmarts("C(O)C(O)C(O)"),

    "sodium":
        Chem.MolFromSmarts("[Na+]"),

    "potassium":
        Chem.MolFromSmarts("[K+]"),

    "calcium":
        Chem.MolFromSmarts("[Ca+2]"),

    "iron":
        Chem.MolFromSmarts("[Fe]"),

    "copper":
        Chem.MolFromSmarts("[Cu]"),

    "zinc":
        Chem.MolFromSmarts("[Zn]")
}


def extract_features(mol):

    if mol is None:
        return {}

    features = {}

    # Molecular properties
    features["molecular_weight"] = round(
        Descriptors.MolWt(mol), 2
    )

    features["logp"] = round(
        Descriptors.MolLogP(mol), 2
    )

    features["num_atoms"] = mol.GetNumAtoms()

    # Functional groups
    for name, pattern in PATTERNS.items():

        features[name] = int(
            mol.HasSubstructMatch(pattern)
        )

    # Gameplay-style properties
    features["flammable"] = float(
        features["alkene"] or
        features["alkyne"] or
        features["alcohol"]
    )

    features["acidic"] = float(
        features["carboxylic_acid"]
    )

    features["basic"] = float(
        features["amine"]
    )

    features["reactive"] = float(
        features["halogen"] or
        features["alkene"]
    )

    return features

def parse_reaction_smiles(reaction_smiles):

    try:
        reactants_smiles, products_smiles = \
            reaction_smiles.split(">>")

    except:
        return None

    reactants = reactants_smiles.split(".")
    products = products_smiles.split(".")

    return {
        "reactants": reactants,
        "products": products
    }

def process_molecule(smiles):

    mol = Chem.MolFromSmiles(smiles)

    if mol is None:
        return None

    return {
        "smiles": smiles,
        "features": extract_features(mol)
    }

def process_dataset(csv_path):

    df = pd.read_csv(csv_path)

    processed_data = []

    for idx, row in df.iterrows():

        reaction_smiles = row["Original_reaction"]

        parsed = parse_reaction_smiles(
            reaction_smiles
        )

        if parsed is None:
            continue

        reactants_data = []
        products_data = []

        # Process reactants
        for smiles in parsed["reactants"]:

            mol_data = process_molecule(smiles)

            if mol_data:
                reactants_data.append(mol_data)

        # Process products
        for smiles in parsed["products"]:

            mol_data = process_molecule(smiles)

            if mol_data:
                products_data.append(mol_data)

        processed_reaction = {

            "reaction_id": idx,

            "reactants": reactants_data,

            "products": products_data,

            "metadata": {
                "split": row.get("Split", ""),
                "holdout": row.get("Holdout", False)
            }
        }

        processed_data.append(
            processed_reaction
        )

    return processed_data

def save_json(data, output_path):

    with open(output_path, "w", encoding="utf-8") as f:

        json.dump(
            data,
            f,
            indent=2,
            ensure_ascii=False
        )

if __name__ == "__main__":

    INPUT_CSV = "app/utils/labeled_test.csv"

    OUTPUT_JSON = "processed_reactions.json"

    processed = process_dataset(INPUT_CSV)

    save_json(
        processed,
        OUTPUT_JSON
    )

    print("=" * 50)
    print("DONE")
    print("Total reactions:", len(processed))
    print("Saved to:", OUTPUT_JSON)