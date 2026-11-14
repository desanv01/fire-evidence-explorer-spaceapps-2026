"""Build the reviewed FLEX subset from a pinned NASA PSI CSV snapshot."""

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


FILENAME = "PSI-69_Experimental table_FLEX.csv"
INPUT_SHA256 = "37c88ce8ae9391b7544ff630a45ce87543d04d317cdbfbed104fe7d5c27e1b96"
SOURCE = {
    "id": "psi-69-flex-table-v1",
    "title": "NASA PSI Flame Extinguishment Experiment (FLEX) Experimental Table",
    "url": "https://psi.nasa.gov/physci/repo/data/investigations/PSI-69",
    "version": "Investigation 5, CSV file 1",
    "license": "CC0-1.0",
    "doi": "10.60555/mbq8-0451",
}
VERSION = "flex-psi69-v5-table-v1-subset-1"
TESTS = tuple(range(1, 32))
IDENTITY_HEADERS = ("FLEX Test #", "FLEX Identifier", "Test Date", "Test GMT")
FIELDS = (
    # key, label, kind, unit, original header
    ("fuel", "Fuel", "condition", None, "Fuel"),
    ("pressure", "Ambient pressure", "condition", "mmHg", "Ambient pressure; mmHg"),
    ("oxygen", "Initial ambient oxygen", "condition", "mole fraction", "O initial ambient composition; mole fraction"),
    ("nitrogen", "Initial ambient nitrogen", "condition", "mole fraction", "N initial ambient composition; mole fraction"),
    ("carbon_dioxide", "Initial ambient carbon dioxide", "condition", "mole fraction", "CO initial ambient composition; mole fraction"),
    ("helium", "Initial ambient helium", "condition", "mole fraction", "He initial ambient composition; mole fraction"),
    ("diameter", "Initial droplet diameter", "condition", "mm", "Droplet initial diameter; mm"),
    ("extinction_diameter", "Droplet diameter at visible flame extinction", "outcome", "mm", "Visible flame extinction diameter; mm"),
    # Table IX of NASA/TP-2015-216046 confirms the rate unit and gas species labels.
    ("burning_rate", "Burning rate", "outcome", "mm²/s", "Burning rate; mm"),
    ("burn_time", "Burn time", "outcome", "s", "Burn time; s"),
    ("test_end", "Test end", "outcome", None, "Test end"),
)


def make_field(spec, cell, line, column, test_number, identifier):
    key, label, kind, unit, header = spec
    token = cell.strip()
    if token in {"", "–", "-"}:
        value = None
    elif unit is None:
        value = token
    else:
        value = float(token)
        if not math.isfinite(value):
            raise ValueError(f"Nonfinite number in CSV row {line}, column {column}")

    letter = chr(ord("A") + column - 1)
    locator = (
        f"{FILENAME}, CSV row {line}, column {letter} ({header}), "
        f"FLEX Test #{test_number} ({identifier})"
    )
    return {
        "key": key,
        "label": label,
        "kind": kind,
        "value": value,
        "unit": unit,
        "original": cell if cell else None,
        "locator": locator,
        "sourceId": SOURCE["id"],
    }


def build(input_path):
    actual_hash = hashlib.sha256(input_path.read_bytes()).hexdigest()
    if actual_hash != INPUT_SHA256:
        raise ValueError(f"Source snapshot SHA-256 differs from the reviewed CSV: {actual_hash}")

    runs = []
    with input_path.open(encoding="cp1252", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        expected_headers = IDENTITY_HEADERS + tuple(spec[-1] for spec in FIELDS)
        if tuple(next(reader)) != expected_headers:
            raise ValueError("Unexpected NASA FLEX CSV headers")

        for row in reader:
            line = reader.line_num
            if len(row) != len(expected_headers):
                raise ValueError(f"Unexpected cell count in CSV row {line}")
            test_number = int(row[0])
            if test_number not in TESTS:
                continue
            identifier = row[1]
            if not identifier or line != test_number + 1:
                raise ValueError(f"Unexpected test identity or position in CSV row {line}")
            fields = [
                make_field(spec, cell, line, column, test_number, identifier)
                for column, (spec, cell) in enumerate(zip(FIELDS, row[4:], strict=True), start=5)
            ]
            runs.append({"id": f"FLEX-{test_number:03d}", "investigation": "FLEX", "fields": fields})

    if [run["id"] for run in runs] != [f"FLEX-{number:03d}" for number in TESTS]:
        raise ValueError("Reviewed FLEX tests are missing, out of order, or duplicated")
    return {"version": VERSION, "sources": [SOURCE], "runs": runs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_csv", type=Path)
    parser.add_argument("output_json", type=Path)
    parser.add_argument(
        "--check", action="store_true", help="Verify the existing output byte for byte"
    )
    args = parser.parse_args()
    payload = json.dumps(build(args.source_csv), indent=2, ensure_ascii=False, allow_nan=False)
    output = (payload + "\n").encode("utf-8")
    if args.check:
        if args.output_json.read_bytes() != output:
            parser.exit(1, f"{args.output_json} differs from the reproducible import\n")
        print(f"Verified reproducible output: {args.output_json}")
    else:
        args.output_json.write_bytes(output)


if __name__ == "__main__":
    main()
