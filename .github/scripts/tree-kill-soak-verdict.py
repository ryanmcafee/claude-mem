#!/usr/bin/env python3
"""Tabulate a Windows tree-kill soak into a per-draw, per-test verdict.

Reads the junit.xml each draw of `.github/workflows/windows-tree-kill-soak.yml`
uploaded and reports how the tracked tests landed across every draw.

Exits non-zero unless every expected draw reported a pass for every tracked
test. `skipped` and `absent` are failures on purpose: both mean the assertion
ran zero times, and a run that stayed green on them would look like evidence
for an acceptance criterion nothing measured.
"""

from __future__ import annotations

import json
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SUITE = "killProcessTree end-to-end on this platform"

TRACKED = (
    "kills the root AND its descendant",
    "reaps a descendant when the root is already gone at call time",
)


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


def read_draw(report: Path) -> dict[str, str]:
    """Map tracked test name -> verdict for one draw's junit report."""
    try:
        root = ET.parse(report).getroot()
    except ET.ParseError as exc:
        return {name: f"unreadable ({exc})" for name in TRACKED}

    seen = {
        case.get("name"): verdict_of(case)
        for case in root.iter("testcase")
        if case.get("classname") == SUITE
    }
    return {name: seen.get(name, "absent") for name in TRACKED}


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <artifact-root>")
    root = Path(sys.argv[1])

    results: dict[int, dict[str, str]] = {}
    for draw in expected_draws():
        report = root / f"tree-kill-soak-draw-{draw}" / "junit.xml"
        results[draw] = (
            read_draw(report)
            if report.is_file()
            else {name: "no report" for name in TRACKED}
        )

    lines = ["## Windows tree-kill soak", ""]
    for name in TRACKED:
        passes = sum(1 for row in results.values() if row[name] == "pass")
        lines.append(f"### {name}")
        lines.append("")
        lines.append(f"**{passes}/{len(results)} draws passed**")
        lines.append("")
        lines.append("| draw | verdict |")
        lines.append("| --- | --- |")
        for draw, row in sorted(results.items()):
            lines.append(f"| {draw} | {row[name]} |")
        lines.append("")

    report = "\n".join(lines)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(report + "\n")

    adverse = [
        f"draw {draw}: {name} -> {row[name]}"
        for draw, row in sorted(results.items())
        for name in TRACKED
        if row[name] != "pass"
    ]
    if adverse:
        print("\nSoak did not hold:", file=sys.stderr)
        for entry in adverse:
            print(f"  {entry}", file=sys.stderr)
        return 1

    print(f"\nAll {len(results)} draws passed every tracked test.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
