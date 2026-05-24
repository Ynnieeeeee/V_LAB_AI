from fastapi import APIRouter, Depends
from sqlmodel import Session
import uuid

from app.models.base_db import get_session
from app.models.chemicals import Chemicals
from app.models.profiles import Profiles
from app.utils.chemistry_engine import ChemLite, predict_accurate_reaction
from app.utils.get_current_user import get_current_user
from app.utils.subscription_utils import require_active_plan


router = APIRouter()


@router.get("/api/reactions/check")
def check_reaction(
    source_id: uuid.UUID,
    target_id: uuid.UUID,
    session: Session = Depends(get_session),
    user: Profiles = Depends(get_current_user),
):
    """Kiểm tra phản ứng hóa học, chỉ cho user có gói hợp lệ."""
    require_active_plan(session, user.id_profile)

    print("=" * 60)
    print("CHECKING REACTION")
    print("=" * 60)
    print("SOURCE ID:", source_id)
    print("TARGET ID:", target_id)

    source_chem = session.get(Chemicals, source_id)
    target_chem = session.get(Chemicals, target_id)

    print("SOURCE CHEM:", source_chem)
    print("TARGET CHEM:", target_chem)

    if not source_chem or not target_chem:
        return {
            "has_reaction": False,
            "reason": "chemical_not_found",
        }

    print("SOURCE TYPE:", source_chem.chemical_type)
    print("TARGET TYPE:", target_chem.chemical_type)

    accurate_result = predict_accurate_reaction(
        ChemLite(
            id=str(source_chem.id_chemical),
            name_vi=source_chem.name_vi,
            formula=source_chem.formula,
            chemical_type=source_chem.chemical_type,
        ),
        ChemLite(
            id=str(target_chem.id_chemical),
            name_vi=target_chem.name_vi,
            formula=target_chem.formula,
            chemical_type=target_chem.chemical_type,
        ),
    )

    if not accurate_result.get("has_reaction"):
        return {
            "has_reaction": False,
            "engine": "deterministic_chemistry",
            "reaction_source": "verified_rule",
            "reason": accurate_result.get("reason", "no_high_confidence_reaction"),
            "source_chemical": {
                "id": str(source_chem.id_chemical),
                "name": source_chem.name_vi,
                "formula": source_chem.formula,
                "chemical_type": source_chem.chemical_type,
            },
            "target_chemical": {
                "id": str(target_chem.id_chemical),
                "name": target_chem.name_vi,
                "formula": target_chem.formula,
                "chemical_type": target_chem.chemical_type,
            },
            "mascot_speech": "Không có dấu hiệu phản ứng hóa học rõ ràng; đây chủ yếu là trộn vật lý.",
        }

    return {
        **accurate_result,
        "source_chemical": {
            "id": str(source_chem.id_chemical),
            "name": source_chem.name_vi,
            "formula": source_chem.formula,
            "chemical_type": source_chem.chemical_type,
        },
        "target_chemical": {
            "id": str(target_chem.id_chemical),
            "name": target_chem.name_vi,
            "formula": target_chem.formula,
            "chemical_type": target_chem.chemical_type,
        },
        "effects": {
            "fire": 1.0 if accurate_result.get("fire") else 0.0,
            "smoke": 0.6 if accurate_result.get("smoke") else 0.0,
            "gas": 1.0 if accurate_result.get("gas") else 0.0,
            "explosion": 1.0 if accurate_result.get("explosion") else 0.0,
            "heat": 0.5 if accurate_result.get("heat") else 0.0,
        },
        "visual": {
            "result_color": accurate_result.get("color"),
            "precipitate": accurate_result.get("precipitate", False),
            "precipitate_color": accurate_result.get("precipitateColor"),
            "gas_effect": accurate_result.get("gas", False),
            "smoke_effect": accurate_result.get("smoke", False),
            "fire_effect": accurate_result.get("fire", False),
            "explosion_effect": accurate_result.get("explosion", False),
        },
        "reaction_data": {
            "result_chemical_type": accurate_result.get("result_chemical_type", "generic_solution"),
            "equation": accurate_result.get("equation", ""),
            "products": accurate_result.get("products", []),
        },
    }
