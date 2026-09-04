"""Unit test suite for string alphanumeric validation resilience."""

import unittest


def is_string_alphanumeric_safely(raw_text: str | None) -> bool:
    if not raw_text or not isinstance(raw_text, str):
        return False
    return raw_text.isalnum()


class TestStringIsAlphanumericResilience(unittest.TestCase):
    def test_is_alphanumeric_valid(self):
        self.assertTrue(is_string_alphanumeric_safely("User123"))
        self.assertFalse(is_string_alphanumeric_safely("User_123!"))

    def test_is_alphanumeric_none(self):
        self.assertFalse(is_string_alphanumeric_safely(None))


if __name__ == "__main__":
    unittest.main()
