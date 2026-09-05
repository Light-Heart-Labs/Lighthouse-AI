"""Unit test suite for numeric list even and odd partitioning resilience."""

import unittest


def partition_numbers_even_odd(numbers: list | None) -> tuple[list[int], list[int]]:
    if not numbers or not isinstance(numbers, list):
        return ([], [])
    evens, odds = [], []
    for num in numbers:
        try:
            val = int(num)
            if val % 2 == 0:
                evens.append(val)
            else:
                odds.append(val)
        except (ValueError, TypeError):
            continue
    return (evens, odds)


class TestListPartitionEvenOddResilience(unittest.TestCase):
    def test_partition_even_odd_valid(self):
        self.assertEqual(partition_numbers_even_odd([1, 2, 3, 4, 5, 6]), ([2, 4, 6], [1, 3, 5]))

    def test_partition_even_odd_none(self):
        self.assertEqual(partition_numbers_even_odd(None), ([], []))


if __name__ == "__main__":
    unittest.main()
