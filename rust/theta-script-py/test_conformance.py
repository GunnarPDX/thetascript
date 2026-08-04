"""Runs the shared conformance corpus through the Python binding.

Same policy as the Rust and JS harnesses: exact numeric equality with a
1e-9 relative tolerance (transcendental-derived values); err-* fixtures
must error with matching collections, message text ignored.

Usage: python test_conformance.py   (after `maturin develop`)
"""

import json
import pathlib
import sys

import theta_script

CORPUS = pathlib.Path(__file__).resolve().parents[2] / "conformance"

stats = {"numbers": 0, "tolerated": 0}


def compare(got, want, path, diffs):
    if len(diffs) > 5:
        return
    if isinstance(want, (int, float)) and not isinstance(want, bool):
        if not (isinstance(got, (int, float)) and not isinstance(got, bool)):
            diffs.append(f"{path}: got {got!r} want number {want!r}")
            return
        stats["numbers"] += 1
        if got == want:
            return
        if abs(got - want) <= 1e-9 * max(abs(got), abs(want)):
            stats["tolerated"] += 1
            return
        diffs.append(f"{path}: got {got!r} want {want!r}")
    elif isinstance(want, list):
        if not isinstance(got, list) or len(got) != len(want):
            diffs.append(f"{path}: array shape mismatch")
            return
        for k, (x, y) in enumerate(zip(got, want)):
            compare(x, y, f"{path}[{k}]", diffs)
    elif isinstance(want, dict):
        if not isinstance(got, dict) or set(got) != set(want):
            diffs.append(f"{path}: key sets differ {sorted(set(got) ^ set(want))}")
            return
        for k, y in want.items():
            compare(got[k], y, f"{path}.{k}", diffs)
    elif got != want:
        diffs.append(f"{path}: got {got!r} want {want!r}")


def main():
    tapes = json.loads((CORPUS / "tapes.json").read_text())
    fixtures = sorted((CORPUS / "expected").glob("*.json"))
    assert fixtures, "no fixtures found"

    failures = []
    for file in fixtures:
        fx = json.loads(file.read_text())
        name = fx["name"]
        # the corpus itself carries the version contract — the binding must
        # implement exactly the language the fixtures were generated under
        assert theta_script.lang_version() == fx["lang"], (
            f"{name}: binding speaks {theta_script.lang_version()}, fixture is {fx['lang']}"
        )
        got = json.loads(
            theta_script.run_script_json(fx["script"], json.dumps(tapes[fx["tape"]]), json.dumps(fx["opts"]))
        )
        want = fx["expected"]
        if name.startswith("err-"):
            if not isinstance(got["error"], str):
                failures.append(f"{name}: expected an error")
                continue
            got["error"] = want["error"] = None
        diffs = []
        compare(got, want, name, diffs)
        failures.extend(diffs)

    print(
        f"python binding conformance: {len(fixtures) - len(set(f.split(':')[0] for f in failures))}"
        f"/{len(fixtures)} fixtures passed; {stats['numbers']} numbers, {stats['tolerated']} within tolerance"
    )
    if failures:
        print("\n".join(failures[:20]))
        sys.exit(1)


if __name__ == "__main__":
    main()
