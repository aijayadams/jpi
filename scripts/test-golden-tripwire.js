#!/usr/bin/env node
// Tripwire test: intentionally compare decode output to a modified golden CSV
// to verify the diff machinery detects mismatches.
const fs = require('fs');
const path = require('path');

const { decodeJpiFileToCsv } = require('../dist/decomp.js');

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

function main() {
  const examples = path.resolve(__dirname, '..', 'example_files');
  const jpi = path.join(examples, 'U250901.JPI');
  const badCsv = path.join(examples, 'Flt598_tripwire.csv');

  const { headers, rows } = decodeJpiFileToCsv(jpi, 598);
  const got = composeCsv(headers, rows);
  const want = fs.readFileSync(badCsv, 'utf8');
  const d = diffFirst(want, got);
  if (!d) {
    console.error('Tripwire did not detect a mismatch (unexpected pass)');
    process.exit(1);
  }
  console.error(`Tripwire mismatch detected at line ${d.line}`);
  console.error(`Expected: ${d.a}`);
  console.error(`Actual:   ${d.b}`);
  // Treat detection as success: exit zero.
  process.exit(0);
}

main();
