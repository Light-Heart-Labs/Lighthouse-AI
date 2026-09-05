"""Unit test suite for custom conflict handler dictionary merging resilience."""

import unittest


def merge_dictionaries_with_conflict_handler(dict_a: dict | None, dict_b: dict | None, resolver: callable = None) -> dict:
    if not dict_a or not isinstance(dict_a, dict):
        base_a = {}
    else:
        base_a = dict(dict_a)
    if not dict_b or not isinstance(dict_b, dict):
        return base_a
    for k, v in dict_b.items():
        if k in base_a and callable(resolver):
            try:
                base_a[k] = resolver(base_a[k], v)
            except Exception:
                base_a[k] = v
        else:
            base_a[k] = v
    return base_a


class TestDictMergeWithConflictResilience(unittest.TestCase):
    def test_merge_conflict_valid(self):
        a = {"x": 1, "y": 2}
        b = {"y": 3, "z": 4}
        res = merge_dictionaries_with_conflict_handler(a, b, lambda val1, val2: val1 + val2)
        self.assertEqual(res, {"x": 1, "y": 5, "z": 4})

    def test_merge_conflict_none(self):
        self.assertEqual(merge_dictionaries_with_conflict_handler(None, {"a": 1}), {"a": 1})


if __name__ == "__main__":
    unittest.main()
