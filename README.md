decodejpi
==========

Standalone TypeScript library + CLI to decode JPI (J.P. Instruments) EDM `.JPI` files into CSV.

Highlights
- Implements a TypeScript binary parser for JPI EDM files.
- Validated against two goldens: Flt559.csv (U250118.JPI, flight 559) and Flt598.csv (U250901.JPI, flight 598).
- Supports EDM900/930 single‑engine flights (the included samples). Extending mappings to other models is straightforward.

Build
- Requires Node.js. From project root:
  - First time: `npm install`
  - Rebuild dist/: `npm run build` (or `npx tsc -p tsconfig.json`)
  - Optional watch: `npx tsc -p tsconfig.json --watch`

Tests
- Run golden tests (compares decoder output to provided CSVs and checks summaries):
  - `npm run test:golden`
- What it does:
  - Builds the library, decodes flight 559 from `example_files/U250118.JPI` and flight 598 from `example_files/U250901.JPI`, and compares the results against `example_files/Flt559.csv` and `example_files/Flt598.csv`.
  - Verifies `summarizeFlights()` returns sensible data (e.g., sample count, durations).
  - Prints `Golden tests passed` on success; otherwise shows the first differing line.

CLI usage
- List flights in a JPI (ID, date/time, tach start‑end, tach duration, actual duration, samples, start/end GPS):
  - `node dist/cli.js <path-to.jpi>`
  - JSON output: `node dist/cli.js <path-to.jpi> --json`
  - Example: `node dist/cli.js example_files/U250901.JPI`
- Decode a specific flight to CSV:
  - `node dist/cli.js <path-to.jpi> <flightId> [output.csv]`
  - Example: `node dist/cli.js example_files/U250118.JPI 559 example_files/out559.csv`
- Decode multiple flights:
  - `node dist/cli.js <path-to.jpi> <flightId> <flightId> [outDir]`
  - If `outDir` exists and is a directory, CSVs are written there as `<basename>.flt<ID>.csv`. Otherwise, they are written in the current directory.
- Output format when decoding:
  - First line: CSV headers starting with `INDEX,DATE,TIME,...`
  - Second line: engine tach summary (Start, End, Duration)
  - Subsequent lines: one row per sample, index added by the CLI.

Library usage
- Import API (after building):
  - `import { decodeJpiFileToCsv, decodeJpiBufferToCsv, Decomp } from './dist';`
- One‑shot decode:
  - `const { headers, rows } = decodeJpiFileToCsv('example_files/U250118.JPI', 559);`
  - Compose CSV: `['INDEX', ...headers].join(',')` then each row with an index value.
- Fine‑grained flow:
  - `const buf = fs.readFileSync(jpiPath);`
  - `const d = new Decomp(); d.parseFile(buf);`
  - `const flights = d.listFlights();`
  - `const headers = d.openFlight(flights[0].id);`
  - `let rec = d.readRecord(
        flights[0].date + ' ' + flights[0].time
      ); // returns 'DATE TIME,<values>' or undefined at EOF`
  - Iterate, advancing time by the reported record interval per sample.

Summaries API
- `const summaries = d.summarizeFlights()` returns an array with:
  - `id`, `dateTime`, `samples`
  - `tachStart`, `tachEnd`, `tachDuration` (hours)
  - `actualDuration` (hours between first and last sample times)
  - `startLat`, `startLng`, `endLat`, `endLng`

Notes
- The CLI’s listing mode decodes each flight to compute tach start/end/duration from the HRS column.
- The library emits LAT/LNG using the same string format as JPI exports (e.g., `N39.04.05`), and computes DIF from EGTs per row.
- For other models (e.g., twin/EDM960), extend the header maps and conditionals in `src/decomp.ts` following the existing patterns.
