import unittest
from datetime import date
from unittest.mock import patch
import check


class WatcherTests(unittest.TestCase):
    def test_month_boundaries(self):
        self.assertEqual(check.first_next_month(date(2026, 10, 1)), date(2026, 11, 1))
        self.assertEqual(list(check.month_starts(date(2026, 10, 15), date(2026, 11, 2))),
                         [date(2026, 10, 1), date(2026, 11, 1)])

    def test_ntfy_payload(self):
        with patch.dict("os.environ", {"NTFY_TOPIC": "lachine-test-123"}):
            with patch.object(check, "request_json", return_value={"id": "test"}) as req:
                self.assertTrue(check.notify_ntfy("2026-10-19"))
        args, kwargs = req.call_args
        self.assertEqual(args[0], "https://ntfy.sh/")
        self.assertEqual(kwargs["method"], "POST")
        self.assertEqual(kwargs["payload"]["topic"], "lachine-test-123")
        self.assertIn("2026-10-19", kwargs["payload"]["message"])

    def test_availability_filter(self):
        sample = {"availabilities": ["2026-10-13", "2026-10-19", "2026-10-26", "2026-11-01"]}
        with patch.object(check, 'request_json', return_value=sample) as req:
            result = check.fetch_matching_dates(date(2026, 10, 15), date(2026, 10, 31))
        self.assertEqual(result, {"2026-10-19", "2026-10-26"})
        self.assertEqual(req.call_count, 1)


if __name__ == "__main__":
    unittest.main()
