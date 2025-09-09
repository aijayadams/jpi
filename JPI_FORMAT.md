JPI File Format Primer
======================

This document summarizes the on‑disk structure and decoding rules implemented by the TypeScript decoder. It focuses on EDM900/930 single‑engine flights, which match the included samples.

Top‑level layout
- A `.JPI` file is an ASCII+binary hybrid. It begins with a series of “dollar” records (ASCII lines without the final `*`), then a block of binary flight data.
- The dollar records provide device metadata, configuration, a list of flights with sizes, timestamps, and user ID.

Key dollar records (ASCII)
- `$A,...` Alarm limits (EGT/CHT/battery/oil). Not required for data decoding.
- `$C,Model,FirstConfig,EngFlags,OATFlags,...,SW,Build?,Beta?` Device model (e.g., `900`), firmware version, build, and the first configuration word. Also determines engine degrees (C/F) and OAT unit.
- `$D,<id>,<sizeWords>` One per flight; reports flight ID and size (in 16‑bit words). The total establishes N flights.
- `$F,<fuelUnit>,...` Fuel unit (0=gallon, 1=pound, etc.).
- `$H,<bits>` Misc flags (e.g., a fuel level bit used in the UI).
- `$I,...` Extended config (e.g., CRB flag on 930 builds ≥ 859) – only needed for certain UI behavior.
- `$L,<blockCount>` Marks the start of the binary data block; from here, flight data bytes follow. The start offset of each flight is computed by accumulating the `$D` sizes.
- `$P,<protocol>` Protocol ID for checksum behavior (older XOR vs newer SUM).
- `$T,MM,DD,YY,HH,MM,SS` Timestamp of download; also used for default date.
- `$U,<userName>` Aircraft identifier.
- `$E` End.

Binary flight header (per flight)
- At the start offset for a flight:
  1) `id` (word) – matches `$D` id
  2) `cfgWord[0]` and `cfgWord[1]` (words) – enable/disable sensors (bitfields)
  3) For some models/builds: `cfgWord[2]` and `cfgWord[3]` (words)
  4) Optional `cfgWord[4]` (word) and, if certain bits set, starting `LAT`/`LNG` as signed 32‑bit longs
  5) `fuelUnit` (byte), `horsepower` (byte)
  6) `recordInterval` (word) – seconds between samples
  7) `dateword` (word) – DOS‑like packed date (DD in low 5 bits, month, year)
  8) `timeword` (word) – packed time (seconds in 2‑second ticks, minutes, hours)
  9) `checksum` (byte) – checksum over the header payload (varies by protocol)

Binary flight data (per record)
- Records repeat until the flight size is consumed. Each record layout:
  1) `flg0` and `flg1` (word,word) – must match; bits indicate which of the 16 control groups are present
  2) `mult` (byte) – if non‑zero, a repeat count: the last decoded record should be emitted again without consuming new data (interval may be adjusted by MARK)
  3) For each `byt_idx` (0..15) where the corresponding bit in `flg0` is set:
     - `ctl_byt_idx` (byte) – bitmask indicating which `bit_idx` (0..7) in this group have data bytes
  4) For sign bytes: for each `byt_idx` except 6 and 7, and where `flg0` has that bit set:
     - `sgn_byt_idx` (byte) – sign bit mask aligned to a (possibly shifted) control bit; used to negate certain values
  5) For every 1 bit in `ctl_byt_idx`: one data byte follows. A zero data byte means “not valid” for that field in this record.
  6) `checksum` (byte) – checksum over the record payload; XOR for older devices, SUM (mod 256) for newer/protocol=2

Combining and scaling values
- The mapping from `(byt_idx, bit_idx)` to sensors (e.g., `E1`, `C1`, `MAP`) depends on model/firmware. For EDM900/930, the mapping tables are implemented directly in `src/decomp.ts`.
- Some sensors combine low/high bytes; scaling depends on location. Examples:
  - Many channels are unscaled integers; output as VB `Conversion.Str` (space‑prefixed positives).
  - `MAP` has a 10x scale.
  - Fuel flow (`FF/FF2`, `USD/FL/…`) scale depends on fuel units.
  - `LAT`/`LNG` accumulate as running totals; the values are converted to `Ndd.mm.ss` / `Wddd.mm.ss` strings.
  - `HRS` (Hobbs) uses special first‑record sign treatment.
- DIF is computed per row as the difference between the max and min EGTs visible in that row.

Running totals
- Some values are cumulative deltas (e.g., LAT/LNG, HP in some modes). The decoder keeps a `running_total` that is adjusted by the signed delta each record.
- Initial LAT/LNG totals are seeded from the flight header when present (930/900 with certain builds).

MARKs and interval changes
- The `MARK` channel encodes special flags in the low bits:
  - 0: none, 1: X marker, 2: `[`, 3: `]`, 4: `<`, 5: `>`
  - `<` and `[` cause the decoder to use `recordInterval=1s` (fast capture). `>` and `]` return to the original interval.
- The exporter emits edge‑only MARK glyphs (no repetition across rows).

Validity and repeats
- Each data byte’s zero value means “NA” for that measurement in that record. Validity typically persists across records unless explicitly cleared by a zero byte.
- When `mult` is set in a record, the previous decoded record should be emitted again (repeat), advancing time by the current interval.
- GPS values (LAT/LNG) are not carried forward arbitrarily; repeats carry them implicitly, but normal rows rely on the current record’s validity and running totals.

Checksums
- Older devices and specific models/versions use XOR of record bytes; newer devices and `protocol=2` (seen in later firmware) use SUM mod 256.

Mapping tables
- The lists of headers, bit positions, and scales are defined in `src/decomp.ts` (e.g., initialization for the 107 firmware mapping). The current implementation includes the EDM900/930 single‑engine mapping needed for the included samples.

Further reading
- See `src/decomp.ts` for the concrete implementation of the parsing and mapping logic.
