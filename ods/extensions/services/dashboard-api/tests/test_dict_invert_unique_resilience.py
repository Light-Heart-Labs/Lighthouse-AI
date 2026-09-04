"""Unit test suite for safe unique value dictionary inversion resilience."""

import unittest


def invert_dictionary_unique_safely(d: dict | None) -> dict:
    if not d or not isinstance(d, dict):
        return {}
    res = {}
    for k, v in d.items():
        try:
            res[v] = k
        except TypeError:
            continue
    return res


class TestDictInvertUniqueResilience(unittest.TestCase):
    def test_invert_dict_valid(self):
        data = {"a": 1, "b": 2, "c": 3}
        self.assertEqual(invert_dictionary_unique_safely(data), {1: "a", 2: "b", 3: "c"})

    def test_invert_dict_none(self):
        self.assertEqual(invert_dictionary_unique_safely(None), {})


if __name__ == "__main__":
    unittest.main()
