"""Production stage selection must also work for a brand-new, unsubmitted order."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from atelier.production import sync_stage


class TestProductionStage(unittest.TestCase):
	def test_new_ready_and_delivered_orders(self):
		for delivered, status, expected in (
			(None, "Open", "تصميم"),
			(0, "Completed", "جاهز للتسليم"),
			(100, "Open", "سُلّم"),
		):
			with self.subTest(delivered=delivered, status=status):
				order = SimpleNamespace(project="verification", per_delivered=delivered, atelier_stage="جديد", db_set=Mock())
				with patch("atelier.production.steps_of", return_value=[SimpleNamespace(status=status, kind="تصميم")]):
					sync_stage(order)
				order.db_set.assert_called_once_with("atelier_stage", expected)
