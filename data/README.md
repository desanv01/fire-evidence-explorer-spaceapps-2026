# FLEX dataset

`flex.json` contains tests FLEX-001 through FLEX-031 from NASA's Flame Extinguishment Experiment. The 31 consecutive runs cover two fuels and several ambient pressures and gas mixtures. They represent the first page of the report's Table IX. The full PSI CSV contains 274 runs. [NASA PSI investigation](https://psi.nasa.gov/physci/repo/data/investigations/PSI-69) · [NASA technical report](https://ntrs.nasa.gov/citations/20150023456)

`flex.sources.json` records the source version, checksum, license, selection, transformations and report locations. Each field in `flex.json` names its source and gives the exact CSV row, column and FLEX identifier. Reported values retain their magnitudes and raw cell text. Missing values use JSON null. Table IX establishes the burning-rate unit in mm²/s and resolves the abbreviated gas headers. Appendix A.1 explains that some droplet diameters at visible extinction were estimated by extrapolating burning history. [NASA technical report](https://ntrs.nasa.gov/citations/20150023456)

From the repository root, use Python 3.10 or newer and pass the CSV downloaded from the investigation's Experimental Table. The importer requires the SHA-256 recorded in the manifest. The input CSV can be stored anywhere locally.

```sh
python scripts/import_flex.py "/path/to/PSI-69_Experimental table_FLEX.csv" data/flex.json
python scripts/import_flex.py "/path/to/PSI-69_Experimental table_FLEX.csv" data/flex.json --check
```
