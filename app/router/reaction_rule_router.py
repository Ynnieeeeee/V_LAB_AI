from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from app.models.base_db import get_session
from app.models.reaction_rules import ReactionRules
from app.models.chemicals import Chemicals
import uuid

router = APIRouter()

@router.get("/api/reactions/check")
def check_reaction(source_id: uuid.UUID, target_id: uuid.UUID, session: Session = Depends(get_session)):
    """Kiểm tra phản ứng hóa học"""
    print("SOURCE ID:", source_id)
    print("TARGET ID:", target_id)

    source_chem = session.get(Chemicals, source_id)
    target_chem = session.get(Chemicals, target_id)

    print("SOURCE CHEM:", source_chem)
    print("TARGET CHEM:", target_chem)

    if not source_chem or not target_chem:
        return {
            "has_reaction": False
        }
    
    stmt = select(ReactionRules).where(
        ReactionRules.source_type == source_chem.chemical_type,
        ReactionRules.target_type == target_chem.chemical_type
    )
    result = session.exec(stmt).first()

    if not result:
        stmt = select(ReactionRules).where(
            ReactionRules.source_type == target_chem.chemical_type,
            ReactionRules.target_type == source_chem.chemical_type
        )
        result = session.exec(stmt).first()

    if not result:
        return {
            "has_reaction": False
        }    
    
    speech = result.mascot_speech.format(
        source_name=source_chem.name_vi,
        target_name=target_chem.name_vi,
        formula_source=source_chem.formula,
        formula_target=target_chem.formula,
        formula_gas=result.formula_gas
    )

    # DEBUG API PRINTING
    print("SOURCE TYPE:", source_chem.chemical_type)
    print("TARGET TYPE:", target_chem.chemical_type)
    print("REACTION FOUND:", result)

    return {
        "has_reaction": True,
        "result_color": result.result_color,
        "gas_effect": result.gas_effect,
        "mascot_speech": speech,
        "result_chemical_type": "generic_solution",
        "result_chemical_id": str(source_chem.id_chemical)
    }
    