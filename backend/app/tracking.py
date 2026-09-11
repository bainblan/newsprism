"""Story identity: matching this run's clustering groups to durable story ids.

This module is deliberately pure — no database access, no I/O — so the
matching algorithm can be unit-tested without a running app. See
``docs/api-contract.md``'s "ID stability" section for the contract this
implements, and ``app/store.py`` for how the results get persisted.

The core move is separating identity from composition: a group produced by
this run's clustering is anonymous. It is matched against the *previous* run's
stories by article overlap, and inherits an id where the match is good enough.
Unmatched groups mint a fresh id; unmatched stories age out (or, if they lost
a contested match, retire into the winner as an alias).
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

STORY_ID_PREFIX = "s_"


def new_story_id() -> str:
    """Mint an id derived from NOTHING.

    That is the whole point: an id with no relationship to content cannot be
    invalidated by content changing. Never hash membership into this.
    """
    return f"{STORY_ID_PREFIX}{uuid4().hex[:12]}"


@dataclass(frozen=True)
class ExistingStory:
    """A story as it stood at the start of this run.

    ``window_members`` is that story's stored membership restricted to the
    *current* clustering window — comparing against full cumulative
    membership would be wrong, since a freshly clustered group only ever
    holds in-window articles.
    """

    id: str
    window_members: frozenset[str]
    first_seen_at: str


@dataclass(frozen=True)
class MatchResult:
    #: Final story id for each group, parallel to the ``groups`` list passed
    #: in. Either inherited from an existing story or freshly minted.
    group_story_ids: list[str]
    #: Loser story id -> survivor story id, for existing stories that had a
    #: genuine eligible match this run but lost the greedy race for it (i.e.
    #: a merge). These must become permanent aliases.
    retired_into: dict[str, str]
    #: Existing story ids that were neither claimed as a survivor nor
    #: retired as a merge loser this run. Includes stories aging out (no
    #: window members at all) and stories that simply had no adequate match.
    #: Their stored membership is left untouched; only ``archived`` may change.
    unclaimed_story_ids: set[str]


def match_groups_to_stories(
    groups: list[list[str]],
    existing: list[ExistingStory],
    threshold: float,
) -> MatchResult:
    """Match anonymous clustering groups to durable existing stories.

    Containment, not Jaccard: Jaccard (``|A∩B| / |A∪B|``) punishes growth — a
    2-article story growing to 5 scores 2/5 = 0.4 and would fail any sane
    threshold, breaking the id for the exact reason this module exists.
    Containment (``overlap / min(|A|, |B|)``) scores that case 2/2 = 1.0:
    every original article is still present, so it is clearly the same story
    with more coverage.
    """
    candidates = [story for story in existing if story.window_members]

    # (overlap, containment, |S_window|, first_seen_at, story_id, group_index)
    pairs: list[tuple[int, float, int, str, str, int]] = []
    for group_index, group in enumerate(groups):
        gset = frozenset(group)
        if not gset:
            continue
        for story in candidates:
            overlap = len(gset & story.window_members)
            if overlap == 0:
                continue
            containment = overlap / min(len(gset), len(story.window_members))
            if containment < threshold:
                continue
            pairs.append(
                (
                    overlap,
                    containment,
                    len(story.window_members),
                    story.first_seen_at,
                    story.id,
                    group_index,
                )
            )

    # Overlap must sort before containment. This is not cosmetic: an
    # overlap-of-1 pair always scores containment 1.0, so containment-first
    # sorting would let a stray single article outrank a genuine ancestor.
    # Example: old story [a1,a2,a3,a4] vs new group [a1,a2,a5,a6,a7,a8] scores
    # containment 0.5, while an unrelated old singleton [a5] scores 1.0 and
    # would steal the id under containment-first sorting. Overlap-first puts
    # the real ancestor (overlap 2) ahead of the singleton (overlap 1).
    pairs.sort(key=lambda p: (-p[0], -p[1], -p[2], p[3], p[4]))

    claimed_groups: set[int] = set()
    claimed_stories: set[str] = set()
    group_assignment: dict[int, str] = {}
    for overlap, containment, swin_len, first_seen_at, story_id, group_index in pairs:
        if group_index in claimed_groups or story_id in claimed_stories:
            continue
        group_assignment[group_index] = story_id
        claimed_groups.add(group_index)
        claimed_stories.add(story_id)

    # A candidate story that lost the greedy race is a merge loser only if it
    # actually had an eligible pair whose group ended up claimed by someone
    # else. A story with no eligible pairs at all is just aging out, not
    # merging. ``pairs`` is already sorted best-first, so the first matching
    # entry for this story is its best (and correct) retirement target.
    retired_into: dict[str, str] = {}
    for story in candidates:
        if story.id in claimed_stories:
            continue
        for overlap, containment, swin_len, first_seen_at, story_id, group_index in pairs:
            if story_id != story.id:
                continue
            survivor = group_assignment.get(group_index)
            if survivor is not None:
                retired_into[story.id] = survivor
            break

    group_story_ids = [
        group_assignment.get(group_index) or new_story_id()
        for group_index in range(len(groups))
    ]

    unclaimed_story_ids = {
        story.id
        for story in existing
        if story.id not in claimed_stories and story.id not in retired_into
    }

    return MatchResult(
        group_story_ids=group_story_ids,
        retired_into=retired_into,
        unclaimed_story_ids=unclaimed_story_ids,
    )
