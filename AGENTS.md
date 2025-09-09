# AGENTS guide for `decodejpi`

This guide is for future agents and humans working in this repo. It explains the project layout, build/test flows, strict decoder invariants that must not regress, and working conventions to keep diffs surgical and safe.

## Scope & Intent
- Applies to the entire repository unless a more specific AGENTS.md exists deeper in the tree.
- Optimize for minimal, focused changes. Preserve public API and on-disk formats unless explicitly requested.

## Purpose
- A standalone TypeScript library + CLI to decode JPI (J.P. Instruments) EDM `.JPI` flight logs into CSV.
- Validated via golden exports stored in `example_files/`.

## Layout
- `src/` — TypeScript sources
  - `decomp.ts` — core decoder implementation
  - `cli.ts` — CLI entry
  - `index.ts` — library exports
  - `types.ts` — shared types (e.g., `FlightSummary`)
- `dist/` — compiled JS output (ignored by Git)
- `example_files/` — JPI/CSV golden files used by tests
- `scripts/` — dev/test scripts (e.g., golden test runner)
- `README.md` — user-facing documentation
- `JPI_FORMAT.md` — format primer and maintainer notes
- `.gitignore` — excludes `node_modules/`, `dist/`, etc.

## Environment
- Requires Node.js and npm. Use a current LTS version of Node.
- No external runtime dependencies beyond TypeScript toolchain.

## Build & Test
- Build from project root:
  - `npm install`
  - `npm run build`
- Golden tests (CSV diff + summary sanity):
  - `npm run test:golden`
  - Decodes flights 559 and 598 and compares to CSVs in `example_files/`. Any mismatch prints the first differing line and exits non‑zero.

## CLI
- List flights: `node dist/cli.js <path-to.jpi> [--json]`
- Decode one: `node dist/cli.js <path-to.jpi> <flightId> [out.csv]`
- Decode many: `node dist/cli.js <path-to.jpi> <flightId> <flightId> [outDir]`
  - If `outDir` exists, CSVs are written as `<basename>.flt<ID>.csv` inside it; else current directory.

## Library API
- `decodeJpiFileToCsv(path, flightId)` → `{ headers: string[], rows: string[][] }`.
- `decodeJpiBufferToCsv(buf, flightId)` → same as above for `Uint8Array`.
- `Decomp` class:
  - `parseFile(buf)` / `listFlights()` / `openFlight(id)` / `readRecord(dateStr)` / `decodeFlightToRows(id)`
  - `summarizeFlights()` → `FlightSummary[]` with tach/actual durations and first/last GPS coordinates.

## Decoder Invariants (Do Not Regress)
- Endianness & signedness:
  - 16‑bit/32‑bit fields are big‑endian; 32‑bit signed values use two’s complement.
  - `getLong()` returns `NaN` on underflow (no sentinel). Only seed running totals when the value is finite.
- Per‑record structure:
  - `flg0 == flg1` required; `mult` repeats the last decoded record without consuming new data bytes (advance time using current interval).
  - Apply checksum checks before accepting a record.
- Validity rules:
  - Data byte value 0 means “NA” for that field in the current record.
  - Validity usually persists across records unless explicitly cleared by a zero byte in that field.
  - Do not blanket carry‑forward GPS (LAT/LNG); repeats carry them implicitly. Normal rows rely on per‑record validity and running totals.
  - DIF uses only EGTs valid in the current record (not previously carried values).
- LAT/LNG formatting and seeds:
  - Output formatting must match JPI exports, e.g., `N39.04.05`, `W094.53.86`.
  - Seed LAT/LNG running totals from the flight header only when present and finite.
- MARK handling:
  - Only output edge glyphs (`[`, `]`, `<`, `>`); do not repeat across rows.
  - `[`/`<` switch to 1s interval; `]`/`>` restore original interval.
- CSV header & summary:
  - CSV headers begin with `INDEX,DATE,TIME,...` and include a tach summary line.
  - Do not re‑introduce an `FM` column.

## Dev Loop (Recommended)
- Make minimal changes in `src/` and update types in `src/types.ts` if required.
- `npm run build` to produce `dist/`.
- Smoke test CLI with one of the example JPI files in `example_files/`.
- Run `npm run test:golden` and ensure zero diffs.
- If decoding logic changes expected output, update the golden CSVs deliberately and document why in `README.md` and/or `JPI_FORMAT.md`.

## Coding Conventions
- TypeScript only; keep style consistent with surrounding code.
- Avoid large refactors and drive‑by formatting.
- Prefer small, readable helpers over cleverness; performance is secondary to correctness and fidelity to JPI exports.
- Keep `dist/` and `node_modules/` out of version control (already ignored).

## Extending Models
- Current mapping targets EDM900/930 single‑engine.
- To add variants (e.g., twins), extend header initialization tables in `src/decomp.ts` following existing patterns.
- Add/update golden tests in `example_files/` to cover the new model.

## Common Pitfalls
- Misapplied endianness or signedness when reading 16/32‑bit values.
- Seeding running totals (e.g., LAT/LNG) when the header value is not finite.
- Carrying GPS forward in non‑repeat rows; only repeats imply carry.
- Computing DIF using stale EGTs rather than only currently valid values.
- Emitting non‑JPI formatting for coordinates, times, or headers.

## PR/Change Checklist
- Build passes (`npm run build`).
- Golden tests pass (`npm run test:golden`) or goldens updated with clear justification.
- Decoder invariants respected (see above).
- Public API unchanged unless explicitly requested; docs updated when behavior changes.
- No commits of `dist/` or `node_modules/`.
