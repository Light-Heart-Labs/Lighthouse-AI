"""Unit test suite for word order reversal string formatting resilience."""

import unittest


def reverse_string_word_order(text: str | None) -> str:
    if not text or not isinstance(text, str):
        return ""
    words = text.split()
    return " ".join(reversed(words))


class TestStringReverseWordsResilience(unittest.TestCase):
    def test_reverse_words_valid(self):
        self.assertEqual(reverse_string_word_order("the quick brown fox"), "fox brown quick the")

    def test_reverse_words_none(self):
        self.assertEqual(reverse_string_word_order(None), "")


if __name__ == "__main__":
    unittest.main()
