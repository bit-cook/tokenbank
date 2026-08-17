"""社区圈内容：场景(scene) + 插件(mod/设定)。从 coterie 原生搬入，仅网页。

两层归属：owner_id NULL = 官方/预定义（管理员后台改）；owner_id=用户 = 自定义。
内容保护：插件 content 仅作者/管理员可见；买家购买后经服务端注入使用、看不到原文；
其他人只看 intro 描述。场景 persona/greeting 同理（运行时注入、不下发）。
"""

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database as db
from auth import get_current_user_id
from admin_router import auth_admin

# 用户端（挂 /user）与管理员端（挂 /admin）两个 router
router = APIRouter()
admin_router = APIRouter()


# ── 请求模型 ──────────────────────────────────────────────────────────────────

class SceneIn(BaseModel):
    name: str
    icon: str = ""
    intro: str = ""
    category: str = ""
    default_model: str = ""
    persona: str = ""
    greeting: str = ""
    circle_id: Optional[int] = None
    is_public: bool = False


class ModIn(BaseModel):
    name: str
    intro: str = ""
    content: dict = {}
    price: int = 0
    type: str = "setting"
    trigger: str = "always"
    trigger_keywords: str = ""   # 逗号分隔（前端输入即字符串；DB 层兼容 list）


class ShareModIn(BaseModel):
    mod_id: int
    price: int = 0


class ShelfIn(BaseModel):
    circle_ids: list[int] = []


# ── helpers ───────────────────────────────────────────────────────────────────

async def _require_member(circle_id: int, uid: int):
    ids = await db.get_user_circle_ids(uid)
    if circle_id not in ids:
        raise HTTPException(403, "不是圈子成员")


async def _own_scene_or_404(scene_id: int, uid: int) -> dict:
    s = await db.get_studio_scene(scene_id)
    if not s or s.get("owner_id") != uid:
        raise HTTPException(404, "场景不存在或无权限")
    return s


async def _own_mod_or_404(mod_id: int, uid: int) -> dict:
    m = await db.get_studio_mod(mod_id)
    if not m or m.get("owner_id") != uid:
        raise HTTPException(404, "插件不存在或无权限")
    return m


# ════════════════════════════ 用户端 · 场景 ════════════════════════════════════

@router.get("/studio/scenes")
async def my_scenes(uid: int = Depends(get_current_user_id)):
    # 自己的场景：owner 可见完整（含 persona/greeting，供编辑）
    return {"scenes": await db.list_scenes_owned(uid)}


@router.post("/studio/scenes")
async def create_scene(req: SceneIn, uid: int = Depends(get_current_user_id)):
    if not req.name.strip():
        raise HTTPException(400, "场景名不能为空")
    data = req.dict()
    if data.get("circle_id"):
        await _require_member(data["circle_id"], uid)
    return {"scene": await db.create_studio_scene(uid, data)}


@router.put("/studio/scenes/{scene_id}")
async def update_scene(scene_id: int, req: SceneIn, uid: int = Depends(get_current_user_id)):
    await _own_scene_or_404(scene_id, uid)
    data = req.dict()
    if data.get("circle_id"):
        await _require_member(data["circle_id"], uid)
    return {"scene": await db.update_studio_scene(scene_id, data)}


@router.delete("/studio/scenes/{scene_id}")
async def delete_scene(scene_id: int, uid: int = Depends(get_current_user_id)):
    await _own_scene_or_404(scene_id, uid)
    await db.delete_studio_scene(scene_id)
    return {"ok": True}


@router.get("/circles/{circle_id}/scenes")
async def circle_scenes(circle_id: int, uid: int = Depends(get_current_user_id)):
    await _require_member(circle_id, uid)
    scenes = await db.list_circle_scenes(circle_id)
    # 圈内场景对成员：公开视图（去 persona/greeting，运行时才注入）
    return {"scenes": [db._scene_public(s) for s in scenes]}


async def _scene_accessible(scene: dict, uid: int) -> bool:
    """场景可访问：官方(owner None) / 本人 / 圈内成员。"""
    if scene.get("owner_id") is None or scene.get("owner_id") == uid:
        return True
    cid = scene.get("circle_id")
    if cid:
        return cid in (await db.get_user_circle_ids(uid))
    return bool(scene.get("is_public"))


@router.get("/studio/scenes/{scene_id}/view")
async def scene_view(scene_id: int, uid: int = Depends(get_current_user_id)):
    """场景 chat 页元数据：name/icon/intro/greeting/default_model —— **不含 persona**（运行时服务端注入）。"""
    s = await db.get_studio_scene(scene_id)
    if not s or not await _scene_accessible(s, uid):
        raise HTTPException(404, "场景不存在或无权限")
    return {"scene": {
        "id": s["id"], "name": s.get("name", ""), "icon": s.get("icon", ""),
        "intro": s.get("intro", ""), "greeting": s.get("greeting", ""),
        "default_model": s.get("default_model", ""), "category": s.get("category", ""),
    }}


async def build_scene_system_prompt(scene: dict, uid: int) -> str:
    """服务端组装场景系统提示：persona +（已购 always 插件的 content）。前端永不见。"""
    parts = []
    if scene.get("persona"):
        parts.append(str(scene["persona"]).strip())
    try:
        for mid in await db.list_purchased_mod_ids(uid):
            m = await db.get_studio_mod(mid)
            if not m or m.get("trigger") != "always":
                continue
            try:
                c = json.loads(m.get("content") or "{}")
            except Exception:
                c = {}
            if isinstance(c, dict) and c.get("text"):
                parts.append(str(c["text"]).strip())
    except Exception:
        pass
    return "\n\n".join(p for p in parts if p)


# ════════════════════════════ 用户端 · 插件 ════════════════════════════════════

@router.get("/studio/mods")
async def my_mods(uid: int = Depends(get_current_user_id)):
    # 自己的插件：owner 可见 content（供编辑）
    return {"mods": await db.list_mods_owned(uid)}


@router.post("/studio/mods")
async def create_mod(req: ModIn, uid: int = Depends(get_current_user_id)):
    if not req.name.strip():
        raise HTTPException(400, "插件名不能为空")
    return {"mod": await db.create_studio_mod(uid, req.dict())}


@router.put("/studio/mods/{mod_id}")
async def update_mod(mod_id: int, req: ModIn, uid: int = Depends(get_current_user_id)):
    await _own_mod_or_404(mod_id, uid)
    return {"mod": await db.update_studio_mod(mod_id, req.dict())}


@router.delete("/studio/mods/{mod_id}")
async def delete_mod(mod_id: int, uid: int = Depends(get_current_user_id)):
    await _own_mod_or_404(mod_id, uid)
    await db.delete_studio_mod(mod_id)
    return {"ok": True}


@router.get("/circles/{circle_id}/mods")
async def circle_mods(circle_id: int, uid: int = Depends(get_current_user_id)):
    await _require_member(circle_id, uid)
    mods = await db.list_circle_mods(circle_id)   # 已不含 content
    purchased = set(await db.list_purchased_mod_ids(uid))
    for m in mods:
        m["mine"] = (m.get("owner_id") == uid)
        m["purchased"] = (m["id"] in purchased) or m["mine"]
    return {"mods": mods}


@router.post("/circles/{circle_id}/mods")
async def share_mod(circle_id: int, req: ShareModIn, uid: int = Depends(get_current_user_id)):
    await _require_member(circle_id, uid)
    await _own_mod_or_404(req.mod_id, uid)   # 只能分享自己的
    await db.share_mod_to_circle(circle_id, req.mod_id, uid, max(0, req.price))
    return {"ok": True, "price": max(0, req.price)}


@router.delete("/circles/{circle_id}/mods/{mod_id}")
async def unshare_mod(circle_id: int, mod_id: int, uid: int = Depends(get_current_user_id)):
    m = await db.get_studio_mod(mod_id)
    if not m:
        raise HTTPException(404, "插件不存在")
    # 作者或圈主可撤下（圈主校验从简：作者本人）
    if m.get("owner_id") != uid:
        raise HTTPException(403, "只有作者可撤下")
    await db.unshare_mod_from_circle(circle_id, mod_id)
    return {"ok": True}


@router.post("/circles/{circle_id}/mods/{mod_id}/buy")
async def buy_mod(circle_id: int, mod_id: int, uid: int = Depends(get_current_user_id)):
    await _require_member(circle_id, uid)
    rows = await db.list_circle_mods(circle_id)
    entry = next((m for m in rows if m["id"] == mod_id), None)
    if not entry:
        raise HTTPException(404, "该插件未在此圈子分享")
    mod = await db.get_studio_mod(mod_id)
    if mod and mod.get("owner_id") == uid:
        raise HTTPException(400, "这是你自己的插件")
    if await db.user_has_purchased_mod(uid, mod_id):
        raise HTTPException(409, "已拥有该插件")
    price = int(entry.get("price") or 0)
    if price > 0:
        ok, balance = await db.deduct_credits(uid, price, model_name=f"studio_mod:{mod_id}", tier="community")
        if not ok:
            raise HTTPException(402, "社区积分不足")
        author_id = mod.get("owner_id") if mod else None
        if author_id:
            await db.award_credits(author_id, price, "studio_mod_sale",
                                   note=f"插件售出 mod={mod_id} buyer={uid}")
    await db.record_mod_purchase(uid, mod_id, price)
    return {"ok": True}


# ── 社区页「可用资源」用：官方场景/插件公开列表（无 content） ──

@router.get("/studio/community")
async def community_studio(uid: int = Depends(get_current_user_id)):
    scenes = [db._scene_public(s) for s in await db.list_official_scenes()]
    mods = [db._mod_public(m) for m in await db.list_official_mods()]
    return {"scenes": scenes, "mods": mods}


# ════════════════════════════ 管理员 · 预定义（owner_id NULL） ════════════════════
# ADMIN_KEY 鉴权；返回含 content 原文（审计/维护）。

@admin_router.get("/studio/scenes", dependencies=[Depends(auth_admin)])
async def admin_list_scenes():
    return {"scenes": await db.list_official_scenes()}


@admin_router.post("/studio/scenes", dependencies=[Depends(auth_admin)])
async def admin_create_scene(req: SceneIn):
    return {"scene": await db.create_studio_scene(None, req.dict())}


@admin_router.put("/studio/scenes/{scene_id}", dependencies=[Depends(auth_admin)])
async def admin_update_scene(scene_id: int, req: SceneIn):
    return {"scene": await db.update_studio_scene(scene_id, req.dict())}


@admin_router.delete("/studio/scenes/{scene_id}", dependencies=[Depends(auth_admin)])
async def admin_delete_scene(scene_id: int):
    await db.delete_studio_scene(scene_id)
    return {"ok": True}


@admin_router.get("/studio/mods", dependencies=[Depends(auth_admin)])
async def admin_list_mods():
    return {"mods": await db.list_official_mods()}


@admin_router.post("/studio/mods", dependencies=[Depends(auth_admin)])
async def admin_create_mod(req: ModIn):
    return {"mod": await db.create_studio_mod(None, req.dict())}


@admin_router.put("/studio/mods/{mod_id}", dependencies=[Depends(auth_admin)])
async def admin_update_mod(mod_id: int, req: ModIn):
    return {"mod": await db.update_studio_mod(mod_id, req.dict())}


@admin_router.delete("/studio/mods/{mod_id}", dependencies=[Depends(auth_admin)])
async def admin_delete_mod(mod_id: int):
    await db.delete_studio_mod(mod_id)
    return {"ok": True}


@admin_router.put("/studio/mods/{mod_id}/circles", dependencies=[Depends(auth_admin)])
async def admin_shelf_mod(mod_id: int, req: ShelfIn):
    """把官方插件上架到指定圈子集合（先清后加），价格取 mod.price。"""
    mod = await db.get_studio_mod(mod_id)
    if not mod:
        raise HTTPException(404, "插件不存在")
    price = int(mod.get("price") or 0)
    # 简化：逐个 share（ON CONFLICT 覆盖价格）。撤下不在集合内的由前端显式调 unshare。
    for cid in req.circle_ids:
        await db.share_mod_to_circle(cid, mod_id, mod.get("owner_id"), price)
    return {"ok": True, "circles": req.circle_ids}
