from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from modules import basis

router = APIRouter(prefix="/api/basis", tags=["Basis"])


class XtbPriceBody(BaseModel):
    xtb_price: float = Field(..., gt=0)


@router.get("")
def list_basis():
    """Saved XTB offsets (xtb price - app price) per symbol."""
    return {"items": basis.list_all()}


@router.get("/{symbol}/preview")
def preview(symbol: str):
    """Last raw 5m bar (price + RO time) to compare against the XTB chart."""
    try:
        return basis.read_app_price(symbol)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/{symbol}")
def save(symbol: str, body: XtbPriceBody):
    """Calibrate: offset = xtb_price - last raw app price."""
    try:
        return basis.set_from_xtb(symbol, body.xtb_price)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/{symbol}")
def remove(symbol: str):
    return {"removed": basis.clear(symbol)}
