# Copyright (c) 2026 OpenNVR
# SPDX-License-Identifier: AGPL-3.0-or-later
"""A camera tour running on a display board (/live/tour/:id)."""

from __future__ import annotations

from harness import selectors as S

from .base import BasePage


class TourPage(BasePage):
    """The tour wall. Build one per tour: the path carries its id."""

    ready = S.TOUR_WALL

    def __init__(self, page, tour_id: int) -> None:
        super().__init__(page)
        self.path = f"/live/tour/{tour_id}"

    def tile_names(self) -> list[str]:
        """Camera names on the page now showing, in tile order."""
        return [n.strip() for n in self.find(S.TOUR_TILE_NAME).all_inner_texts()]

    def step_label(self) -> str:
        return self.find(S.TOUR_STEP).first.inner_text().strip()
