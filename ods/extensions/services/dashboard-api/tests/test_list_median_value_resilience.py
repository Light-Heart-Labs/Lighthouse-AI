"""Unit test suite for statistical median calculation resilience in lists."""

import unittest


def compute_list_median_value(numbers: list | None) -> float | None:
    if not numbers or not isinstance(numbers, list):
        return None
    valid_nums = []
    for num in numbers:
        try:
            valid_nums.append(float(num))
        except (ValueError, TypeError):
            continue
    if not valid_nums:
        return None
    valid_nums.sort()
    n = len(valid_nums)
    mid = n // 2
    if n % 2 == 1:
        return valid_nums[mid]
    return (valid_nums[mid - 1] + valid_nums[mid]) / 2.0


class TestListMedianValueResilience(unittest.TestCase):
    def test_compute_median_odd(self):
        self.assertEqual(compute_list_median_value([3, 1, 2]), 2.0)

    def test_compute_median_even(self):
        self.assertEqual(compute_list_median_value([4, 1, 2, 3]), 2.5)

    def test_compute_median_none(self):
        self.assertEqual(compute_list_median_value(None), None)


if __name__ == "__main__":
    unittest.main()
