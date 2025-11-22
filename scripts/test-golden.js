#!/usr/bin/env node
/*
  Golden file tests for decodejpi
  - Validates decoding of specific flights against provided CSVs
  - Validates summarizeFlights basic shape
*/
const fs = require('fs');
const path = require('path');

const { decodeJpiFileToCsv, decodeJpi, Decomp } = require('../dist/decomp.js');

function composeCsv(headers, rows) {
  const lines = [];
  lines.push(['INDEX', ...headers].join(','));
  // tach summary line
  const hrsIdx = [headers.indexOf('HRS'), headers.indexOf('LHRS')].filter(i => i >= 0)[0];
  if (hrsIdx >= 0) {
    let start, end;
    for (const r of rows) {
      const v = (r[hrsIdx] || '').trim();
      if (v && v !== 'NA') {
        const n = Number(v);
        if (!Number.isNaN(n)) {
          if (start === undefined) start = n;
          end = n;
        }
      }
    }
    if (start !== undefined && end !== undefined) {
      const dur = end - start;
      lines.push(`Engine - Tach Start = ${start.toFixed(1)},Tach End = ${end.toFixed(1)},Tach Duration = ${dur.toFixed(1)}`);
    }
  }
  let idx = 0;
  for (const r of rows) lines.push([String(idx++), ...r].join(','));
  return lines.join('\n') + '\n';
}

function diffFirst(a, b) {
  const al = a.split(/\r?\n/), bl = b.split(/\r?\n/);
  const len = Math.min(al.length, bl.length);
  for (let i = 0; i < len; i++) {
    if (al[i] !== bl[i]) return { line: i + 1, a: al[i], b: bl[i] };
  }
  if (al.length !== bl.length) return { line: len + 1, a: al[len] || '<EOF>', b: bl[len] || '<EOF>' };
  return null;
}

function assertEqualCsv(goldenPath, gotHeaders, gotRows, tag) {
  const want = fs.readFileSync(goldenPath, 'utf8');
  const got = composeCsv(gotHeaders, gotRows);
  const d = diffFirst(want, got);
  if (d) {
    console.error(`Mismatch in ${tag} at line ${d.line}`);
    console.error(`Expected: ${d.a}`);
    console.error(`Actual:   ${d.b}`);
    process.exit(1);
  }
}

function main() {
  const examples = path.resolve(__dirname, '..', 'example_files');

  // Flight 559
  {
    const jpi = path.join(examples, 'U250118.JPI');
    const csv = path.join(examples, 'Flt559.csv');
    const { headers, rows } = decodeJpiFileToCsv(jpi, 559);
    assertEqualCsv(csv, headers, rows, 'U250118.JPI flight 559');
  }

  // Flight 598
  {
    const jpi = path.join(examples, 'U250901.JPI');
    const csv = path.join(examples, 'Flt598.csv');
    const { headers, rows } = decodeJpiFileToCsv(jpi, 598);
    assertEqualCsv(csv, headers, rows, 'U250901.JPI flight 598');
  }

  // Object-row API: decodeJpi should mirror CSV headers/rows
  {
    const jpi = path.join(examples, 'U250118.JPI');
    const { headers: csvHeaders, rows: csvRows } = decodeJpiFileToCsv(jpi, 559);
    const { headers: objHeaders, rows: objRows } = decodeJpi(jpi, 559);

    // Headers: decodeJpi should prepend INDEX and otherwise match
    const expectedHeaders = ['INDEX', ...csvHeaders];
    if (objHeaders.length !== expectedHeaders.length ||
        !objHeaders.every((h, i) => h === expectedHeaders[i])) {
      console.error('decodeJpi headers mismatch');
      console.error('Expected:', expectedHeaders.join(','));
      console.error('Actual:  ', objHeaders.join(','));
      process.exit(1);
    }

    if (objRows.length !== csvRows.length) {
      console.error('decodeJpi row count mismatch');
      console.error('Expected rows:', csvRows.length);
      console.error('Actual rows:  ', objRows.length);
      process.exit(1);
    }

    // Spot-check a few rows (first, middle, last) for field alignment
    const indicesToCheck = [0, Math.floor(objRows.length / 2), objRows.length - 1]
      .filter(i => i >= 0);
    for (const idx of indicesToCheck) {
      const obj = objRows[idx];
      const csv = csvRows[idx];
      if (obj.INDEX !== idx) {
        console.error(`decodeJpi INDEX mismatch at row ${idx}: expected ${idx}, got ${obj.INDEX}`);
        process.exit(1);
      }
      if (obj.DATE !== csv[0] || obj.TIME !== csv[1]) {
        console.error(`decodeJpi DATE/TIME mismatch at row ${idx}`);
        console.error('CSV:', csv[0], csv[1]);
        console.error('OBJ:', obj.DATE, obj.TIME);
        process.exit(1);
      }
      for (let c = 2; c < csvHeaders.length; c++) {
        const key = csvHeaders[c];
        const got = obj[key];
        const want = csv[c];
        if ((got || '') !== (want || '')) {
          console.error(`decodeJpi field mismatch at row ${idx}, column ${key}`);
          console.error('Expected:', want);
          console.error('Actual:  ', got);
          process.exit(1);
        }
      }
    }
  }

  // Summaries sanity check
  {
    const jpi = path.join(examples, 'U250901.JPI');
    const buf = fs.readFileSync(jpi);
    const d = new Decomp();
    d.parseFile(buf);
    const summaries = d.summarizeFlights();
    if (!Array.isArray(summaries) || summaries.length === 0) {
      console.error('summarizeFlights returned no flights');
      process.exit(1);
    }
    const s598 = summaries.find(s => s.id === 598);
    if (!s598) {
      console.error('summary for flight 598 not found');
      process.exit(1);
    }
    // Basic checks: fields present and numeric
    if (typeof s598.samples !== 'number' || s598.samples <= 0) {
      console.error('invalid samples in summary for 598');
      process.exit(1);
    }
    // Allow small rounding variance
    if (s598.tachDuration !== undefined && !(s598.tachDuration >= 0)) {
      console.error('invalid tachDuration');
      process.exit(1);
    }
    if (s598.actualDuration !== undefined && !(s598.actualDuration >= 0)) {
      console.error('invalid actualDuration');
      process.exit(1);
    }
  }

  console.log('Golden tests passed');
}

main();
