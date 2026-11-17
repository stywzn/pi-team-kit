"""A tiny calculator with two deliberate gaps, for trying /team."""

import sys


def calc(a: float, op: str, b: float) -> float:
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b  # TODO: division by zero
    raise ValueError(f"unsupported operator: {op}")


def main(argv: list[str]) -> int:
    # TODO: print usage when the argument count is wrong
    a, op, b = argv[1], argv[2], argv[3]
    print(calc(float(a), op, float(b)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
