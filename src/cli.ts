#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { decodeJpiFileToCsv, Decomp } from './decomp';

function usage() {
  console.error('Usage:');
  console.error('  List flights: decodejpi <JPI file> [--json]');
  console.error('  Decode one:   decodejpi <JPI file> <flightId> [out.csv]');
  console.error('  Decode many:  decodejpi <JPI file> <flightId>... [outDir-or-cwd]');
  process.exit(1);
}

const argv = process.argv.slice(2);
const jpiPath = argv[0];
if (!jpiPath) usage();
const rest = argv.slice(1);
const flags = rest.filter(a => a.startsWith('-'));
const args = rest.filter(a => !a.startsWith('-'));
const jsonFlag = flags.includes('--json');

// If no flightId(s) provided, list flights with summaries
if (args.length === 0) {
  const buf = fs.readFileSync(jpiPath);
  const d = new Decomp();
  d.parseFile(buf);
  const flights = d.listFlights();
  if (flights.length === 0) {
    console.log('No flights found');
    process.exit(0);
  }
  const summaries = d.summarizeFlights();
  if (jsonFlag) {
    console.log(JSON.stringify(summaries, null, 2));
  } else {
    console.log('ID\tDATE\tTIME OFF\tTIME IN\tTach Start-End (h)\tTach Dur (h)\tHobb Dur (h)\tSamples\tStart (LAT,LNG)\tEnd (LAT,LNG)');
    for (const s of summaries) {
      const tachSpan = (s.tachStart !== undefined && s.tachEnd !== undefined) ? `${s.tachStart.toFixed(1)}-${s.tachEnd.toFixed(1)}` : 'NA-NA';
      const tdur = s.tachDuration !== undefined ? s.tachDuration.toFixed(1) : 'NA';
      const adur = s.hobbDuration !== undefined ? s.hobbDuration.toFixed(1) : 'NA';
      const st = (s.startLat && s.startLng) ? `${s.startLat},${s.startLng}` : 'NA';
      const en = (s.endLat && s.endLng) ? `${s.endLat},${s.endLng}` : 'NA';
      const to = s.timeOff ?? 'NA';
      const ti = s.timeIn ?? 'NA';
      console.log(`${s.id}\t${s.dateTime}\t${to}\t${ti}\t${tachSpan}\t${tdur}\t${adur}\t${s.samples}\t${st}\t${en}`);
    }
  }
  process.exit(0);
}

// Decode one or more flights
const numericIds = args.map(a => parseInt(a, 10)).filter(n => Number.isFinite(n));
if (numericIds.length === 0) usage();

function writeFlightCsv(jpi: string, fltId: number, destPath?: string) {
  const { headers, rows } = decodeJpiFileToCsv(jpi, fltId);
  const headerLine = ['INDEX', ...headers].join(',');
  const lines: string[] = [headerLine];
  const hrsIdxList = [headers.indexOf('HRS'), headers.indexOf('LHRS')].filter(i => i >= 0) as number[];
  const hrsIdx = hrsIdxList.length ? hrsIdxList[0] : -1;
  if (hrsIdx >= 0) {
    let start: number | undefined;
    let end: number | undefined;
    for (const r of rows) {
      const v = (r[hrsIdx] || '').trim();
      if (v && v !== 'NA') {
        const num = Number(v);
        if (!Number.isNaN(num)) {
          if (start === undefined) start = num;
          end = num;
        }
      }
    }
    if (start !== undefined && end !== undefined) {
      const dur = end - start;
      lines.push(`Engine - Tach Start = ${start.toFixed(1)},Tach End = ${end.toFixed(1)},Tach Duration = ${dur.toFixed(1)}`);
    }
  }
  let idx = 0;
  for (const row of rows) lines.push([String(idx++), ...row].join(','));
  const out = lines.join('\n') + '\n';
  if (destPath) {
    fs.writeFileSync(destPath, out);
    console.error(`Wrote ${destPath}`);
  } else {
    process.stdout.write(out);
  }
}

// If multiple flights and a trailing argument that looks like a directory, write each flight there.
let outHint: string | undefined;
if (numericIds.length >= 2 && args.length > numericIds.length) {
  outHint = args[args.length - 1];
}

if (numericIds.length === 1) {
  const outPath = args.length >= 2 ? args[1] : undefined;
  writeFlightCsv(jpiPath, numericIds[0], outPath);
} else {
  // Multiple flights
  let outDir = '.';
  if (outHint && fs.existsSync(outHint) && fs.statSync(outHint).isDirectory()) {
    outDir = outHint;
  }
  const base = path.basename(jpiPath, path.extname(jpiPath));
  for (const id of numericIds) {
    const dest = path.join(outDir, `${base}.flt${id}.csv`);
    writeFlightCsv(jpiPath, id, dest);
  }
}
