import unittest

from calc import calc


class CalcTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(calc(1, "+", 2), 3)
        self.assertEqual(calc(5, "-", 2), 3)
        self.assertEqual(calc(2, "*", 3), 6)
        self.assertEqual(calc(6, "/", 3), 2)


if __name__ == "__main__":
    unittest.main()
