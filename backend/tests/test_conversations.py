"""Conversation lineage, isolation, and subtree-deletion regressions."""
from __future__ import annotations

import pytest


async def _register(client, username: str = "alice") -> None:
    response = await client.post(
        "/api/auth/register",
        json={
            "username": username,
            "email": f"{username}@example.com",
            "password": "password123",
        },
    )
    assert response.status_code == 201, response.text


def _root_payload(conv_id: str = "root") -> dict:
    return {
        "id": conv_id,
        "title": "Root history",
        "type": "general",
        "history_id": conv_id,
        "parent_id": None,
        "branch_from_message_index": None,
        "branch_excerpt": None,
        "messages": [
            {"role": "user", "content": "Start"},
            {"role": "assistant", "content": "A representation can collapse."},
            {"role": "user", "content": "Continue"},
            {"role": "assistant", "content": "Later answer"},
        ],
        "created_at": 100,
        "updated_at": 100,
    }


def _branch_payload(
    conv_id: str,
    parent_id: str,
    *,
    history_id: str = "root",
    message_index: int = 1,
    messages: list | None = None,
) -> dict:
    root_messages = _root_payload()["messages"]
    return {
        "id": conv_id,
        "title": "Branch",
        "type": "general",
        "history_id": history_id,
        "parent_id": parent_id,
        "branch_from_message_index": message_index,
        "branch_excerpt": "representation collapse",
        "messages": messages if messages is not None else root_messages[: message_index + 1],
        "created_at": 200,
        "updated_at": 200,
    }


@pytest.mark.asyncio
async def test_branch_lineage_round_trips_and_is_immutable(client):
    await _register(client)
    root = await client.put("/api/conversations/root", json=_root_payload())
    assert root.status_code == 200, root.text

    child_payload = _branch_payload("child", "root")
    child = await client.put("/api/conversations/child", json=child_payload)
    assert child.status_code == 200, child.text
    assert child.json() | {
        "history_id": "root",
        "parent_id": "root",
        "branch_from_message_index": 1,
        "branch_excerpt": "representation collapse",
    } == child.json()

    listed = await client.get("/api/conversations")
    assert listed.status_code == 200
    listed_child = next(row for row in listed.json() if row["id"] == "child")
    assert listed_child["history_id"] == "root"
    assert listed_child["parent_id"] == "root"

    changed = {**child_payload, "parent_id": None, "history_id": "child"}
    response = await client.put("/api/conversations/child", json=changed)
    assert response.status_code == 409
    assert "lineage" in response.text.lower()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        (_branch_payload("bad-role", "root", message_index=0), "assistant"),
        (_branch_payload("bad-index", "root", message_index=99, messages=[]), "assistant"),
        (
            _branch_payload(
                "bad-prefix",
                "root",
                messages=[
                    {"role": "user", "content": "Start"},
                    {"role": "assistant", "content": "Tampered answer"},
                ],
            ),
            "prefix",
        ),
    ],
)
async def test_invalid_branch_shape_is_rejected(client, payload, detail):
    await _register(client)
    assert (await client.put("/api/conversations/root", json=_root_payload())).status_code == 200
    response = await client.put(f"/api/conversations/{payload['id']}", json=payload)
    assert response.status_code == 400
    assert detail in response.text.lower()


@pytest.mark.asyncio
async def test_branch_parent_cannot_reference_another_user(client):
    await _register(client, "alice")
    assert (await client.put("/api/conversations/root", json=_root_payload())).status_code == 200

    await _register(client, "bob")
    response = await client.put(
        "/api/conversations/stolen",
        json=_branch_payload("stolen", "root"),
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_removes_only_requested_subtree(client):
    await _register(client)
    assert (await client.put("/api/conversations/root", json=_root_payload())).status_code == 200
    assert (await client.put("/api/conversations/left", json=_branch_payload("left", "root"))).status_code == 200
    assert (await client.put("/api/conversations/right", json=_branch_payload("right", "root"))).status_code == 200

    left_messages = _branch_payload("left", "root")["messages"] + [
        {"role": "user", "content": "Explain it"},
        {"role": "assistant", "content": "Detailed explanation"},
    ]
    left_update = {**_branch_payload("left", "root"), "messages": left_messages, "updated_at": 250}
    assert (await client.put("/api/conversations/left", json=left_update)).status_code == 200
    leaf = _branch_payload(
        "leaf",
        "left",
        message_index=3,
        messages=left_messages[:4],
    )
    leaf["history_id"] = "root"
    leaf["branch_excerpt"] = "Detailed explanation"
    assert (await client.put("/api/conversations/leaf", json=leaf)).status_code == 200

    deleted = await client.delete("/api/conversations/left")
    assert deleted.status_code == 200
    assert set(deleted.json()["deleted_ids"]) == {"left", "leaf"}

    remaining = {row["id"] for row in (await client.get("/api/conversations")).json()}
    assert remaining == {"root", "right"}
