#!/usr/bin/env python3
"""Tabulate a Windows tree-kill soak into a per-draw, per-test verdict.

Reads the junit.xml each draw of `.github/workflows/windows-tree-kill-soak.yml`
uploaded and reports how the suite landed across every draw.

Exits non-zero unless every expected draw reported a pass for every test the
suite declared. `skipped` is a failure on purpose: it means the assertion ran
zero times, and a run that stayed green on it would look like evidence for an
acceptance criterion nothing measured.

The tracked set is read from the reports rather than hard-coded, so a test that
only exists on an unmerged branch is enforced there and does not fail the soak
on trees that do not carry it. `REQUIRED` is the floor that keeps an empty or
collapsed report from passing, and cross-draw set agreement catches a test that
runs on some runners but not others.
"""

from __future__ import annotations

import json
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SUITE = "killProcessTree end-to-end on this platform"

REQUIRED = ("kills the root AND its descendant",)


def expected_draws() -> list[int]:
    raw = os.environ.get("EXPECTED_DRAWS", "").strip()
    if not raw:
        sys.exit("EXPECTED_DRAWS is empty; cannot tell which draws were dispatched")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.exit(f"EXPECTED_DRAWS is not JSON ({exc}): {raw!r}")
    if not isinstance(parsed, list) or not parsed:
        sys.exit(f"EXPECTED_DRAWS must be a non-empty list, got {raw!r}")
    return [int(draw) for draw in parsed]


def verdict_of(case: ET.Element) -> str:
    if case.find("failure") is not None or case.find("error") is not None:
        return "fail"
    if case.find("skipped") is not None:
        return "skipped"
    return "pass"


def read_draw(report: Path) -> dict[str, str] | str:
    """Map every suite test name -> verdict, or return why the draw is unreadable."""
    if not report.is_file():
        return "no report"
    try:
        root = ET.parse(report).getroot()
    except ET.ParseError as exc:
        return f"unreadable ({exc})"

    return {
        case.get("name", "<unnamed>"): verdict_of(case)
        for case in root.iter("testcase")
        if case.get("classname") == SUITE
    }


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <artifact-root>")
    root = Path(sys.argv[1])

    reads = {
        draw: read_draw(root / f"tree-kill-soak-draw-{draw}" / "junit.xml")
        for draw in expected_draws()
    }
    usable = {draw: row for draw, row in reads.items() if isinstance(row, dict)}
    names = sorted({name for row in usable.values() for name in row})

    adverse = [f"draw {draw}: {row}" for draw, row in sorted(reads.items()) if isinstance(row, str)]
    for draw, row in sorted(usable.items()):
        if not row:
            adverse.append(f"draw {draw}: reported zero tests for {SUITE!r}")
            continue
        adverse.extend(
            f"draw {draw}: required test absent -> {name}" for name in REQUIRED if name not in row
        )
        adverse.extend(
            f"draw {draw}: test other draws ran is absent here -> {name}"
            for name in names
            if name not in row
        )
        adverse.extend(f"draw {draw}: {name} -> {row[name]}" for name in sorted(row) if row[name] != "pass")

    lines = ["## Windows tree-kill soak", ""]
    if not names:
        lines.extend([f"No draw reported a test for `{SUITE}`.", ""])
    for name in names:
        passes = sum(1 for row in usable.values() if row.get(name) == "pass")
        lines.append(f"### {name}")
        lines.append("")
        lines.append(f"**{passes}/{len(reads)} draws passed**")
        lines.append("")
        lines.append("| draw | verdict |")
        lines.append("| --- | --- |")
        for draw, row in sorted(reads.items()):
            got = row if isinstance(row, str) else row.get(name, "absent")
            lines.append(f"| {draw} | {got} |")
        lines.append("")

    report = "\n".join(lines)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(report + "\n")

    if adverse:
        print("\nSoak did not hold:", file=sys.stderr)
        for entry in adverse:
            print(f"  {entry}", file=sys.stderr)
        return 1

    print(f"\nAll {len(reads)} draws passed every one of the {len(names)} tests the suite declared.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
