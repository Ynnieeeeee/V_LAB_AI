"""
Deterministic chemistry engine for the virtual lab.

Goal: prefer chemically valid, explainable reactions over broad type rules.
If a pair is unknown, return has_reaction=False instead of inventing an effect.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ChemLite:
    id: str
    name_vi: str
    formula: str
    chemical_type: str


def _norm(value: str | None) -> str:
    return (value or "").strip().lower().replace(" ", "")


def _names(a: ChemLite, b: ChemLite) -> set[str]:
    return {_norm(a.name_vi), _norm(b.name_vi), _norm(a.formula), _norm(b.formula)}


def _has(pair: set[str], *tokens: str) -> bool:
    normalized = {_norm(t) for t in tokens}
    return any(t in pair for t in normalized)


def _base_result(**kwargs: Any) -> dict[str, Any]:
    result = {
        "has_reaction": True,
        "engine": "deterministic_chemistry",
        "reaction_source": "verified_rule",
        "color": kwargs.get("color"),
        "gas": bool(kwargs.get("gas", False)),
        "smoke": bool(kwargs.get("smoke", False)),
        "fire": bool(kwargs.get("fire", False)),
        "explosion": bool(kwargs.get("explosion", False)),
        "heat": bool(kwargs.get("heat", False)),
        "precipitate": bool(kwargs.get("precipitate", False)),
        "precipitateColor": kwargs.get("precipitateColor"),
        "result_chemical_type": kwargs.get("result_chemical_type", "generic_solution"),
        "equation": kwargs.get("equation", ""),
        "products": kwargs.get("products", []),
        "mascot_speech": kwargs.get("mascot_speech", "Phản ứng hóa học đã xảy ra."),
    }
    return result


def predict_accurate_reaction(source: ChemLite, target: ChemLite) -> dict[str, Any]:
    pair = _names(source, target)
    t = {_norm(source.chemical_type), _norm(target.chemical_type)}

    # Same substance: physical mixing only.
    if str(source.id) == str(target.id) or _norm(source.formula) == _norm(target.formula):
        return {"has_reaction": False, "reason": "same_chemical"}

    # 2Na + 2H2O -> 2NaOH + H2. Sodium metal is dangerous; show gas/heat/fire, not arbitrary color.
    if _has(pair, "Na", "Natri") and _has(pair, "H2O", "Nước"):
        return _base_result(
            gas=True,
            heat=True,
            fire=True,
            explosion=True,
            color="#fff7cc",
            result_chemical_type="strong_base",
            equation="2Na + 2H₂O → 2NaOH + H₂↑",
            products=["NaOH", "H₂"],
            mascot_speech="Natri phản ứng mạnh với nước, tạo Natri hiđroxit và khí H₂; phản ứng tỏa nhiệt nên H₂ có thể bốc cháy.",
        )

    # CuSO4 + 2NaOH -> Cu(OH)2(s) + Na2SO4.
    if _has(pair, "CuSO4", "Đồng(II) Sunfat") and _has(pair, "NaOH", "Natri Hydroxit"):
        return _base_result(
            precipitate=True,
            precipitateColor="#4fc3f7",
            color="#9bd6ff",
            equation="CuSO₄ + 2NaOH → Cu(OH)₂↓ + Na₂SO₄",
            products=["Cu(OH)₂", "Na₂SO₄"],
            mascot_speech="Đã tạo kết tủa Đồng(II) hiđroxit Cu(OH)₂ màu xanh lam.",
        )

    # BaCl2 + H2SO4 -> BaSO4(s) + 2HCl.
    if _has(pair, "BaCl2", "Bari Clorua") and _has(pair, "H2SO4", "Axit Sunfuric"):
        return _base_result(
            precipitate=True,
            precipitateColor="#ffffff",
            color="#f8f8ff",
            equation="BaCl₂ + H₂SO₄ → BaSO₄↓ + 2HCl",
            products=["BaSO₄", "HCl"],
            mascot_speech="Xuất hiện kết tủa Bari sunfat BaSO₄ màu trắng, rất ít tan trong nước.",
        )

    # AgNO3 detects chloride: Ag+ + Cl- -> AgCl(s).
    if _has(pair, "AgNO3", "Bạc Nitrat") and (_has(pair, "HCl", "Axit Clohidric") or _has(pair, "BaCl2", "Bari Clorua")):
        chloride_source = "HCl" if _has(pair, "HCl", "Axit Clohidric") else "BaCl₂"
        equation = "AgNO₃ + HCl → AgCl↓ + HNO₃" if chloride_source == "HCl" else "2AgNO₃ + BaCl₂ → 2AgCl↓ + Ba(NO₃)₂"
        return _base_result(
            precipitate=True,
            precipitateColor="#f5f5f5",
            color="#ffffff",
            equation=equation,
            products=["AgCl"],
            mascot_speech="Ion Ag⁺ gặp ion Cl⁻ tạo kết tủa AgCl màu trắng.",
        )


    # NaOH rắn/kiềm + các axit thường gặp: trung hòa, tỏa nhiệt; không tự sinh khí.
    if _has(pair, "NaOH", "Natri Hydroxit") and _has(pair, "HCl", "Axit Clohidric"):
        return _base_result(
            heat=True,
            color="#ffffff",
            result_chemical_type="neutral_salt_solution",
            equation="NaOH + HCl → NaCl + H₂O",
            products=["NaCl", "H₂O"],
            mascot_speech="Natri hiđroxit trung hòa axit clohiđric, tạo natri clorua và nước; phản ứng tỏa nhiệt nhẹ.",
        )

    if _has(pair, "NaOH", "Natri Hydroxit") and _has(pair, "H2SO4", "Axit Sunfuric"):
        return _base_result(
            heat=True,
            color="#ffffff",
            result_chemical_type="neutral_salt_solution",
            equation="2NaOH + H₂SO₄ → Na₂SO₄ + 2H₂O",
            products=["Na₂SO₄", "H₂O"],
            mascot_speech="Natri hiđroxit trung hòa axit sunfuric, tạo natri sunfat và nước; phản ứng tỏa nhiệt.",
        )

    if _has(pair, "NaOH", "Natri Hydroxit") and _has(pair, "HNO3", "Axit Nitric"):
        return _base_result(
            heat=True,
            color="#ffffff",
            result_chemical_type="neutral_salt_solution",
            equation="NaOH + HNO₃ → NaNO₃ + H₂O",
            products=["NaNO₃", "H₂O"],
            mascot_speech="Natri hiđroxit trung hòa axit nitric, tạo natri nitrat và nước; phản ứng tỏa nhiệt nhẹ.",
        )

    # Amoniac với axit mạnh tạo muối amoni; có thể thấy khói trắng khi hơi NH3 gặp hơi HCl.
    if _has(pair, "NH3", "Amoniac") and _has(pair, "HCl", "Axit Clohidric"):
        return _base_result(
            smoke=True,
            heat=True,
            color="#ffffff",
            result_chemical_type="ammonium_salt_solution",
            equation="NH₃ + HCl → NH₄Cl",
            products=["NH₄Cl"],
            mascot_speech="Amoniac phản ứng với HCl tạo amoni clorua NH₄Cl; có thể quan sát khói trắng/mù muối amoni.",
        )

    if _has(pair, "NH3", "Amoniac") and _has(pair, "HNO3", "Axit Nitric"):
        return _base_result(
            heat=True,
            color="#ffffff",
            result_chemical_type="ammonium_salt_solution",
            equation="NH₃ + HNO₃ → NH₄NO₃",
            products=["NH₄NO₃"],
            mascot_speech="Amoniac trung hòa axit nitric tạo amoni nitrat.",
        )

    # BaCl2 phát hiện ion sulfate, không chỉ với H2SO4 mà cả sulfate sau trung hòa.
    if _has(pair, "BaCl2", "Bari Clorua") and _has(pair, "Na2SO4", "Natri Sunfat", "sulfate", "sunfat"):
        return _base_result(
            precipitate=True,
            precipitateColor="#ffffff",
            color="#f8f8ff",
            equation="Ba²⁺ + SO₄²⁻ → BaSO₄↓",
            products=["BaSO₄"],
            mascot_speech="Ion Ba²⁺ gặp ion SO₄²⁻ tạo kết tủa BaSO₄ màu trắng.",
        )

    # AgNO3 phát hiện halide/iodide: bạc iodua màu vàng nhạt.
    if _has(pair, "AgNO3", "Bạc Nitrat") and _has(pair, "I2", "Iốt"):
        return _base_result(
            precipitate=True,
            precipitateColor="#fff2a8",
            color="#fff8cc",
            equation="Ag⁺ + I⁻ → AgI↓ (mô phỏng thuốc thử iodide)",
            products=["AgI"],
            mascot_speech="Bạc nitrat với ion iodide tạo kết tủa bạc iodua màu vàng nhạt. Với I₂ rắn, đây là mô phỏng khi có iodide trong môi trường.",
        )

    # Iodine với glucose: không phải test tinh bột, nhưng iod có thể bị khử chậm trong môi trường kiềm.
    if _has(pair, "I2", "Iốt") and _has(pair, "NaOH", "Natri Hydroxit"):
        return _base_result(
            color="#fff6d6",
            heat=False,
            equation="I₂ + 2OH⁻ → I⁻ + IO⁻ + H₂O",
            products=["I⁻", "IO⁻", "H₂O"],
            mascot_speech="Iốt bị kiềm làm mất màu dần do tạo iodide/hypoiodite; không sinh khí hay kết tủa rõ.",
        )

    # Reactive metal + acids: hydrogen gas and heat. Sodium can ignite the hydrogen.
    if _has(pair, "Na", "Natri") and (_has(pair, "HCl", "Axit Clohidric") or _has(pair, "H2SO4", "Axit Sunfuric") or _has(pair, "HNO3", "Axit Nitric")):
        acid = "HCl" if _has(pair, "HCl", "Axit Clohidric") else ("H₂SO₄" if _has(pair, "H2SO4", "Axit Sunfuric") else "HNO₃")
        return _base_result(
            gas=True,
            heat=True,
            fire=True,
            explosion=True,
            color="#fff3cc",
            result_chemical_type="salt_solution",
            equation=f"Na + {acid} → muối natri + H₂↑",
            products=["muối natri", "H₂"],
            mascot_speech="Natri gặp axit phản ứng rất mạnh, giải phóng khí H₂ và tỏa nhiều nhiệt; H₂ có thể bốc cháy.",
        )

    if (_has(pair, "Zn", "Kẽm") or _has(pair, "Fe", "Sắt") or _has(pair, "Mg", "Magie")) and (_has(pair, "HCl", "Axit Clohidric") or _has(pair, "H2SO4", "Axit Sunfuric")):
        metal = "Mg" if _has(pair, "Mg", "Magie") else ("Zn" if _has(pair, "Zn", "Kẽm") else "Fe")
        acid = "HCl" if _has(pair, "HCl", "Axit Clohidric") else "H₂SO₄"
        salt = {"Mg": "MgCl₂/MgSO₄", "Zn": "ZnCl₂/ZnSO₄", "Fe": "FeCl₂/FeSO₄"}[metal]
        return _base_result(
            gas=True,
            heat=True,
            color="#f7fbff",
            result_chemical_type="salt_solution",
            equation=f"{metal} + {acid} → {salt} + H₂↑",
            products=[salt, "H₂"],
            mascot_speech="Kim loại hoạt động phản ứng với axit, sinh bọt khí H₂ và tỏa nhiệt nhẹ.",
        )

    # Carbonate / bicarbonate + acid: CO2 bubbles/foam.
    if (_has(pair, "Na2CO3", "Natri Cacbonat", "CaCO3", "Canxi Cacbonat", "NaHCO3", "Natri Bicacbonat") or "carbonate" in t or "cacbonat" in t) and ("strong_acid" in t or "weak_acid" in t or _has(pair, "HCl", "Axit Clohidric", "H2SO4", "Axit Sunfuric", "HNO3", "Axit Nitric")):
        return _base_result(
            gas=True,
            heat=False,
            color="#ffffff",
            result_chemical_type="salt_solution",
            equation="CO₃²⁻ + 2H⁺ → CO₂↑ + H₂O",
            products=["CO₂", "H₂O", "muối"],
            mascot_speech="Muối cacbonat gặp axit sủi bọt mạnh do giải phóng khí CO₂.",
        )

    # Concentrated sulfuric acid with sugar/glucose-like carbohydrate: dehydration creates steam/smoke and black carbon.
    if _has(pair, "H2SO4", "Axit Sunfuric") and (_has(pair, "glucose", "Glucozơ", "sucrose", "Đường", "C12H22O11") or "carbohydrate" in t):
        return _base_result(
            smoke=True,
            heat=True,
            color="#1f1f1f",
            result_chemical_type="charred_mixture",
            equation="C₆H₁₂O₆ --H₂SO₄ đặc--> C + H₂O (mô phỏng)",
            products=["C", "H₂O"],
            mascot_speech="Axit sunfuric đặc hút nước mạnh khỏi đường/glucozơ, tạo khối than đen và hơi/khói do tỏa nhiệt.",
        )

    # Strong acid + strong base neutralization. Visible effect is mild heat; no fake gas/smoke.
    if (("strong_acid" in t or "weak_acid" in t) and ("strong_base" in t or "weak_base" in t)):
        return _base_result(
            heat=True,
            color="#ffffff",
            equation="H⁺ + OH⁻ → H₂O",
            products=["muối", "H₂O"],
            mascot_speech="Đây là phản ứng trung hòa axit–bazơ, tạo muối và nước; thường không sinh khí nếu không có muối cacbonat hoặc kim loại hoạt động.",
        )

    # Phenolphthalein: indicator color change, not a chemical reaction producing new substance.
    if "indicator_phenol" in t and ("strong_base" in t or "weak_base" in t):
        return _base_result(
            color="#ff4fa3",
            equation="Phenolphthalein: không màu ⇌ hồng trong môi trường bazơ",
            products=["indicator_color_change"],
            mascot_speech="Phenolphthalein chuyển sang màu hồng trong môi trường bazơ. Đây là đổi màu chỉ thị, không phải phản ứng tạo kết tủa hay khí.",
        )
    if "indicator_phenol" in t and ("strong_acid" in t or "weak_acid" in t):
        return _base_result(
            color="#ffffff",
            equation="Phenolphthalein không màu trong môi trường axit hoặc trung tính",
            products=["indicator_color_change"],
            mascot_speech="Phenolphthalein không màu trong môi trường axit hoặc trung tính.",
        )

    # Iodine + glucose/starch-like carbohydrate: visible brown/blue-black is not reliable for glucose.
    if _has(pair, "I2", "Iốt") and _has(pair, "glucose", "Glucozơ"):
        return {"has_reaction": False, "reason": "iodine_does_not_give_starch_test_with_glucose"}

    # KMnO4 can oxidize ethanol; keep as a high-confidence educational visual.
    if _has(pair, "KMnO4", "Kali Pemanganat") and _has(pair, "ethanol", "Ancol Etylic"):
        return _base_result(
            color="#8b5a2b",
            precipitate=True,
            precipitateColor="#6b4b2a",
            heat=True,
            equation="KMnO₄ oxi hóa C₂H₅OH; MnO₄⁻ bị khử tạo MnO₂ màu nâu trong môi trường trung tính/kiềm",
            products=["MnO₂", "sản phẩm oxi hóa của ethanol"],
            mascot_speech="KMnO₄ oxi hóa ethanol; màu tím nhạt dần và có thể xuất hiện MnO₂ nâu tùy môi trường.",
        )

    return {"has_reaction": False, "reason": "no_high_confidence_reaction"}
