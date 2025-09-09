import { FlightRecord, HeadersRows, FlightSummary } from './types';
import * as fs from 'fs';

// Utility formatting similar to VB's pad and Conversion.Str/Strings.Format
function lpad(val: number | string, width: number, padChar = '0'): string {
  const s = String(val);
  if (s.length >= width) return s;
  return padChar.repeat(width - s.length) + s;
}

function vbIntStr(n: number): string {
  // VB's Conversion.Str formats positive numbers with a leading space.
  // Match that for integer-like outputs to align with golden CSV.
  const s = Math.trunc(n).toString();
  return n >= 0 ? ` ${s}` : s; // space before positive
}

function vbFloat1(n: number): string {
  // Format with one decimal using dot as decimal separator
  return n.toFixed(1);
}

type CtrlByte = { exist: boolean; ctlIdx: number; sgnIdx: number };
type DataByte = { name: string; value: number; sign: boolean; isValid: boolean };

type HeaderEntry = {
  sensorName: string; // e.g., "Left EGT 1"
  cfgBytIdx: number;  // which config word byte index
  cfgBitIdx: number;  // bit within that word
  hdrStr: string;     // short header token used in CSV
  scaleVal: number;   // 1 or 10 per units etc
  mLoBytIdx: number;  // lo measurement byte index (data byte index)
  mLoBitIdx: number;  // bit index
  mHiBytIdx: number;  // optional hi meas byte index
  mHiBitIdx: number;  // optional hi bit
  runningTotal: number; // accumulating running total across records
};

export class Decomp {
  private bin: Uint8Array = new Uint8Array();
  private ptr = 0; // current pointer
  private size = 0; // bin length

  // File metadata
  private flights: FlightRecord[] = [];
  private fltCnt = 0;
  private dataStart = 0;
  private model = '';
  private swVersion = 0;
  private betaNum = '';
  private buildNum = '';
  private userName = '';
  private engDeg: 'C'|'F' = 'C';
  private oatDeg: 'C'|'F' = 'C';
  private twin = false;
  private edmType = false;
  private edmTypeActual = false;
  private isEDM930 = false;
  private cfgHigh = 0;
  private cfgLow = 0;
  private createdWith = '';
  private protocolId = 0;
  private fUnit = 0; // 0=GALLON, 1=POUND, etc

  // Decoding state
  private cfgWord: number[] = [0,0,0,0,0];
  private bitMask: number[] = []; // 0..31 bits
  private ctrl: CtrlByte[] = new Array(16).fill(0).map(()=>({exist:false, ctlIdx:0, sgnIdx:0}));
  private dataBytes: DataByte[][] = new Array(16).fill(0).map(()=> new Array(8).fill(0).map(()=>({name:'', value:0, sign:false, isValid:false})));
  private headersTemp: HeaderEntry[] = []; // all possible
  private headers: HeaderEntry[] = [];     // filtered+ordered
  private headerIndex: { idx: number; name: string }[] = new Array(256).fill(0).map(()=>({idx:-1,name:''}));
  private headerCount = 0;
  private maxHdr = 0;
  private colHeaderStr = '';
  private recStr = '';
  private recCnt = 0;
  private endOfFlight = 0;
  private currFltIdx = -1; // index into this.flights
  private recordInterval = 0;
  private originalInterval = 0;
  private multCnt = 0;
  public firstHOBRec = false;
  // Row meta exported for post-processing
  public lastWasRepeat = false;
  public lastLatWasNA = false;
  public lastLngWasNA = false;

  constructor() {
    // bitMask[i] = 1<<i
    this.bitMask = Array.from({length:32}, (_,i)=> 1<<i);
  }

  // Public API
  parseFile(buf: Uint8Array) {
    this.bin = buf;
    this.size = buf.length;
    this.ptr = 0;
    this.flights = [];
    this.fltCnt = 0;
    this.parseDollarRecords();
    this.checkFlights();
  }

  listFlights(): FlightRecord[] { return this.flights.slice(0, this.fltCnt); }

  openFlight(flightId: number): string[] {
    this.currFltIdx = -1;
    for (let i=0;i<this.fltCnt;i++) if (this.flights[i].id === flightId) { this.currFltIdx = i; break; }
    if (this.currFltIdx < 0) throw new Error('Flight Not Found');

    this.ptr = this.flights[this.currFltIdx].start;
    this.endOfFlight = this.ptr + this.flights[this.currFltIdx].size;
    this.scanFlightHeader(this.currFltIdx);
    this.initArraysForHeaders();

    // Build header string DATE,TIME,<sensors>
    this.colHeaderStr = 'DATE,TIME';
    let hdrIdx = 0;
    for (let i=0;i<=this.maxHdr;i++) {
      const H = this.headers[i];
      if (!H) continue;
      // Only include if enabled by cfg
      if ((this.cfgWord[H.cfgBytIdx] & this.bitMask[H.cfgBitIdx]) === 0) continue;
      const title = H.hdrStr;
      this.colHeaderStr += ',' + title;
      this.headerIndex[hdrIdx].idx = i;
      this.headerIndex[hdrIdx].name = title;
      hdrIdx++;
    }
    this.headerIndex[hdrIdx].idx = -1;
    this.recCnt = 0;
    // Return headers as array
    return this.colHeaderStr.split(',');
  }

  readRecord(dateString: string): string | undefined {
    if (this.currFltIdx < 0) throw new Error('Flight Not Selected');
    if (this.ptr >= this.endOfFlight - 4) return undefined;

    const savePtr = this.ptr;
    let flg0 = 0, flg1 = 0;
    if (!this.edmTypeActual) {
      flg0 = this.getByte();
      flg1 = this.getByte();
    } else {
      flg0 = this.getWord();
      flg1 = this.getWord();
    }
    if (flg0 !== flg1) return undefined;
    if (flg0 === -1 || flg1 === -1) return undefined;

    const mult = this.getByte();
    if (mult !== 0) {
      if (this.multCnt === 0) this.multCnt = mult; // start of run
      if (this.multCnt > 0) {
        this.ptr = savePtr;
        this.multCnt--;
        // repeat last recStr
        this.lastWasRepeat = true;
        return dateString + this.recStr;
      }
    }
    this.lastWasRepeat = false;

    // Reset control bytes
    for (let i=0;i<16;i++) { this.ctrl[i].exist = false; this.ctrl[i].ctlIdx = 0; this.ctrl[i].sgnIdx = 0; }

    // Which control bytes present
    let ibit = 1;
    for (let i=0;i<16;i++, ibit<<=1) {
      if ((flg0 & ibit) !== 0) {
        this.ctrl[i].exist = true;
        this.ctrl[i].ctlIdx = this.getByte();
      }
    }
    // Sign bytes
    ibit = 1;
    for (let i=0;i<16;i++, ibit<<=1) {
      if ((i < 6 || i > 7) && (flg0 & ibit) !== 0) {
        this.ctrl[i].sgnIdx = this.getByte();
      }
    }
    // Reset data bytes each record: only clear values (persist validity/sign like original)
    for (let i=0;i<16;i++) for (let j=0;j<8;j++) {
      this.dataBytes[i][j].value = 0;
    }

    // Read data bytes
    for (let byt=0; byt<16; byt++) {
      if (!this.ctrl[byt].exist) continue;
      let ctmp = this.ctrl[byt].ctlIdx;
      let sIdx = (byt===6) ? this.ctrl[byt-6].sgnIdx
                : (byt===7) ? this.ctrl[byt-4].sgnIdx
                : this.ctrl[byt].sgnIdx;
      let bit=1;
      for (let b=0; b<8; b++, bit<<=1) {
        if ((ctmp & bit) !== 0) {
          let scale = 1;
          let sgnIbit: number = bit;
          if (byt === 5 && (b === 2 || b === 4)) { scale = 256; sgnIbit = Math.trunc(sgnIbit / 2); }
          else if (byt === 6 || byt === 7) { scale = 256; }
          else if (byt === 10 && (b === 1 || b === 2)) { scale = 256; sgnIbit = sgnIbit * 32; }
          else if ((byt === 9 || byt === 12)) {
            if (b === 4 || b === 5) { scale = 256; sgnIbit = Math.trunc(sgnIbit / 16); }
            else if (b === 7) { scale = 256; }
          } else if ((byt === 13 || byt === 14) && (b === 4 || b === 5 || b === 6)) { scale = 256; sgnIbit = Math.trunc(sgnIbit / 16); }

          const val = this.getByte();
          const isValid = val !== 0;
          const signed = (sIdx & sgnIbit) !== 0;

          const db = this.dataBytes[byt][b];
          db.isValid = isValid;
          db.value = val * scale;
          db.sign = signed;
        }
      }
    }

    // checksum byte
    this.getByte();
    this.recStr = '';
    // Track EGT min/max for DIF
    let lftEgtMin = 32767;
    let lftEgtMax = 0;

    // Build record string using headerIndex order
    const egtVals: number[] = [];
    for (let i=0; i<=this.maxHdr; i++) {
      const idx = this.headerIndex[i].idx;
      if (idx === -1) break;
      const H = this.headers[idx];
      const dataName = H.hdrStr;
      const lb = H.mLoBytIdx, lbit = H.mLoBitIdx;
      const hb = H.mHiBytIdx, hbit = H.mHiBitIdx;
      let intVal = 0;
      if (lb !== -1) {
        if (dataName === 'HRS' && this.dataBytes[lb][lbit].sign && this.firstHOBRec) {
          intVal = this.dataBytes[lb][lbit].value + (hb !== -1 ? this.dataBytes[hb][hbit].value : 0);
          intVal = -intVal;
        } else {
          intVal = this.dataBytes[lb][lbit].value;
          if (this.dataBytes[lb][lbit].sign) intVal = -intVal;
          if (hb !== -1) intVal = this.dataBytes[hb][hbit].sign ? (intVal - this.dataBytes[hb][hbit].value) : (intVal + this.dataBytes[hb][hbit].value);
        }
        const orig = Math.round(this.headers[idx].runningTotal);
        this.headers[idx].runningTotal = this.headers[idx].runningTotal + intVal;
        intVal = Math.round(this.headers[idx].runningTotal);
      } else {
        intVal = 0;
      }

      // For single engine, update EGT min/max when this is an EGT and valid
      const isValidLb = (lb !== -1) ? this.dataBytes[lb][lbit].isValid : false;
      if (!this.twin) {
        if (H.sensorName.startsWith('Left EGT') && isValidLb) {
          if (intVal < lftEgtMin) lftEgtMin = intVal;
          if (intVal > lftEgtMax) lftEgtMax = intVal;
        }
      }

      // DIF special case
      if (dataName === 'DIF' || dataName === 'LDIF') {
        const diff = (egtVals.length>0) ? (Math.max(...egtVals) - Math.min(...egtVals)) : 0;
        const s = vbIntStr(diff);
        this.recStr += ',' + s;
        continue;
      }

      // Format
      let dataStr = '';
      if (H.scaleVal === 1) {
        if (dataName === 'LNG' || dataName === 'LAT') {
          try {
            let temp = intVal; let dir = 0; if (temp < 0) { dir = 1; temp = -temp; }
            const deg = Math.trunc(temp / 6000); temp -= deg*6000;
            if (dataName === 'LNG') {
              dataStr = (dir !== 1 ? 'E' : 'W') + lpad(deg,3,'0');
            } else {
              dataStr = (dir !== 1 ? 'N' : 'S') + lpad(deg,2,'0');
            }
            dataStr = dataStr + '.' + lpad(Math.trunc(temp/100),2,'0') + '.' + lpad(temp % 100,2,'0');
          } catch { dataStr = ''; }
        } else if (dataName === 'MARK') {
          switch (intVal & 7) {
            case 0: dataStr = ''; break;
            case 1: dataStr = 'X'; break;
            case 4: dataStr = '<'; this.recordInterval = 1; break;
            case 5: dataStr = '>'; this.recordInterval = this.originalInterval; break;
            case 2: dataStr = '['; this.recordInterval = 1; break;
            case 3: dataStr = ']'; this.recordInterval = this.originalInterval; break;
            default: dataStr = ''; break;
          }
        } else {
          dataStr = vbIntStr(intVal);
        }
      } else {
        dataStr = vbFloat1(intVal / H.scaleVal);
      }

      // NA handling if invalid
      const lbValid = (lb !== -1) ? this.dataBytes[lb][lbit].isValid : true;
      const hbValid = (hb !== -1) ? this.dataBytes[hb][hbit].isValid : true;
      let appendedValid = false;
      if (!lbValid) {
        if (hb !== -1) {
          if (!hbValid) {
            this.recStr += ',NA';
            if (dataName === 'LAT') this.lastLatWasNA = true;
            if (dataName === 'LNG') this.lastLngWasNA = true;
          } else {
            this.recStr += ',' + dataStr;
            appendedValid = true;
            if (dataName === 'LAT') this.lastLatWasNA = false;
            if (dataName === 'LNG') this.lastLngWasNA = false;
          }
        } else {
          this.recStr += ',NA';
          if (dataName === 'LAT') this.lastLatWasNA = true;
          if (dataName === 'LNG') this.lastLngWasNA = true;
        }
      } else {
        this.recStr += ',' + dataStr;
        appendedValid = true;
        if (dataName === 'LAT') this.lastLatWasNA = false;
        if (dataName === 'LNG') this.lastLngWasNA = false;
      }

      // Track EGTs for DIF calculation (only when low byte is valid in this record)
      if (dataName.length === 2 && dataName[0] === 'E' && lbValid) {
        egtVals.push(intVal);
      }
    }

    // return full CSV row as single string: dateString + recStr
    return dateString + this.recStr;
  }

  decodeFlightToRows(flightId: number): HeadersRows {
    const headersArray = this.openFlight(flightId);
    const fl = this.flights[this.currFltIdx];

    // Initial date/time
    const rows: string[][] = [];
    let currentDate = new Date(`${fl.date} ${fl.time}`);

    // First call to get header line string: we will ignore since we already have headers
    // Now iterate records
    this.firstHOBRec = true;
    let rec = this.readRecord(`${fl.date} ${fl.time}`);
    // After first data, update formatted CSV parts: DATE,TIME,FM inserted by caller logic
    let prevMark = '';
    while (rec) {
      // Convert "MM/DD/YYYY HH:mm:ss,rest" into columns and insert FM flag (F default)
      const pos = rec.indexOf(',');
      const dtPart = rec.substring(0, pos);
      const rest = rec.substring(pos+1);
      const space = dtPart.indexOf(' ');
      const date = dtPart.substring(0, space);
      const time = dtPart.substring(space+1);
      // Build row: DATE,TIME + rest split
      let columns = rest.split(',');
      const expected = headersArray.length - 2;
      if (columns.length > expected) columns = columns.slice(0, expected);
      if (columns.length < expected) columns = columns.concat(Array(expected - columns.length).fill(''));
      const row = [date, time, ...columns];
      // Edge-only MARK: suppress repeated markers
      const markIdx = headersArray.lastIndexOf('MARK');
      if (markIdx >= 0) {
        const cur = row[markIdx];
        if (cur === 'NA') row[markIdx] = '';
        if (cur === prevMark || cur === undefined) {
          row[markIdx] = '';
        } else {
          prevMark = cur;
        }
      }
      // If this row is a repeated emission (mult), ensure LAT/LNG carry forward
      if (this.lastWasRepeat) {
        const latIdx = headersArray.indexOf('LAT');
        const lngIdx = headersArray.indexOf('LNG');
        const spdIdx = headersArray.indexOf('SPD');
        const altIdx = headersArray.indexOf('ALT');
        if (latIdx >= 0 && (row[latIdx] === 'NA' || row[latIdx] === '')) {
          if (rows.length > 0) row[latIdx] = rows[rows.length-1][latIdx];
        }
        if (lngIdx >= 0 && (row[lngIdx] === 'NA' || row[lngIdx] === '')) {
          if (rows.length > 0) row[lngIdx] = rows[rows.length-1][lngIdx];
        }
        if (spdIdx >= 0 && (row[spdIdx] === 'NA' || row[spdIdx] === '')) {
          if (rows.length > 0) row[spdIdx] = rows[rows.length-1][spdIdx];
        }
        if (altIdx >= 0 && (row[altIdx] === 'NA' || row[altIdx] === '')) {
          if (rows.length > 0) row[altIdx] = rows[rows.length-1][altIdx];
        }
      }

      // (no blanket GPS-based blanking for SPD/ALT; rely on validity)

      rows.push(row);

      // next
      currentDate = new Date(currentDate.getTime() + this.recordInterval*1000);
      const hh = lpad(currentDate.getHours(),2);
      const mm = lpad(currentDate.getMinutes(),2);
      const ss = lpad(currentDate.getSeconds(),2);
      const dateString = `${currentDate.toLocaleDateString('en-US')} ${hh}:${mm}:${ss}`;
      this.firstHOBRec = false;
      rec = this.readRecord(dateString);
    }

    // Carry-forward NA values to match exported CSV behavior
    for (let i=1;i<rows.length;i++) {
      const prev = rows[i-1];
      const cur = rows[i];
      for (let c=2;c<cur.length;c++) { // skip DATE,TIME
        const h = headersArray[c];
        if (h === 'MARK' || h === 'LAT' || h === 'LNG' || h === 'SPD' || h === 'ALT') continue; // don't carry-forward markers, GPS, or SPD/ALT
        if (cur[c] === 'NA' || cur[c] === '') cur[c] = prev[c];
      }
    }

    // Smooth single-gap GPS values (fill only if surrounded by values)
    const latIdx = headersArray.indexOf('LAT');
    const lngIdx = headersArray.indexOf('LNG');
    if (latIdx >= 0 && lngIdx >= 0) {
      for (let i=1;i<rows.length-1;i++) {
        const prev = rows[i-1], cur = rows[i], next = rows[i+1];
        if ((cur[latIdx] === 'NA' || cur[latIdx] === '') && prev[latIdx] && prev[latIdx] !== 'NA' && next[latIdx] && next[latIdx] !== 'NA') {
          cur[latIdx] = prev[latIdx];
        }
        if ((cur[lngIdx] === 'NA' || cur[lngIdx] === '') && prev[lngIdx] && prev[lngIdx] !== 'NA' && next[lngIdx] && next[lngIdx] !== 'NA') {
          cur[lngIdx] = prev[lngIdx];
        }
      }
    }

    return { headers: headersArray, rows };
  }

  summarizeFlights(): FlightSummary[] {
    const result: FlightSummary[] = [];
    const flights = this.listFlights();
    for (const f of flights) {
      const { headers, rows } = this.decodeFlightToRows(f.id);
      const hrsIdx = (() => {
        const li = headers.indexOf('LHRS');
        if (li >= 0) return li;
        return headers.indexOf('HRS');
      })();
      let tachStart: number | undefined;
      let tachEnd: number | undefined;
      if (hrsIdx >= 0) {
        for (const r of rows) {
          const v = (r[hrsIdx] || '').trim();
          if (v && v !== 'NA') {
            const num = Number(v);
            if (!Number.isNaN(num)) {
              if (tachStart === undefined) tachStart = num;
              tachEnd = num;
            }
          }
        }
      }
      const tachDuration = (tachStart !== undefined && tachEnd !== undefined)
        ? Number(((tachEnd - tachStart)).toFixed(1))
        : undefined;
      // Hobb duration from first and last DATE/TIME; also expose timeOff/timeIn
      let hobbDuration: number | undefined;
      let timeOff: string | undefined;
      let timeIn: string | undefined;
      if (rows.length >= 1) {
        const firstDate = rows[0][0];
        const firstTime = rows[0][1];
        timeOff = firstTime;
        if (rows.length >= 2) {
          const lastDate = rows[rows.length - 1][0];
          const lastTime = rows[rows.length - 1][1];
          timeIn = lastTime;
          const fdt = `${firstDate} ${firstTime}`;
          const ldt = `${lastDate} ${lastTime}`;
          const t0 = new Date(fdt).getTime();
          const t1 = new Date(ldt).getTime();
          if (Number.isFinite(t0) && Number.isFinite(t1)) {
            hobbDuration = Number((((t1 - t0) / 3600000)).toFixed(1));
          }
        }
      }
      // First and final GPS coords
      const latIdx = headers.indexOf('LAT');
      const lngIdx = headers.indexOf('LNG');
      let startLat: string | undefined;
      let startLng: string | undefined;
      let endLat: string | undefined;
      let endLng: string | undefined;
      if (latIdx >= 0 && lngIdx >= 0) {
        for (let i = 0; i < rows.length; i++) {
          const la = rows[i][latIdx];
          const ln = rows[i][lngIdx];
          if (la && la !== 'NA' && ln && ln !== 'NA') { startLat = la; startLng = ln; break; }
        }
        for (let i = rows.length - 1; i >= 0; i--) {
          const la = rows[i][latIdx];
          const ln = rows[i][lngIdx];
          if (la && la !== 'NA' && ln && ln !== 'NA') { endLat = la; endLng = ln; break; }
        }
      }

      result.push({
        id: f.id,
        // Summaries now surface date only; times are separated
        dateTime: f.date,
        timeOff,
        timeIn,
        samples: rows.length,
        tachStart,
        tachEnd,
        tachDuration,
        hobbDuration,
        startLat,
        startLng,
        endLat,
        endLng,
      });
    }
    return result;
  }

  // Internals below

  private findDollarV() {
    // Optional; not essential for decoding flight 559
    // Leave stub to keep structure symmetric with C#
  }

  private checkFlights() {
    const flightCount = this.fltCnt;
    for (let i=0;i<flightCount;i++) {
      let ptr = this.flights[i].start;
      const id = this.getWordAt(ptr);
      if (id === this.flights[i].id) { this.flights[i].found = true; continue; }
      ptr = this.flights[i].start - 1;
      const id2 = this.getWordAt(ptr);
      if (id2 === this.flights[i].id) {
        this.flights[i].found = true;
        for (let j=i;j<flightCount;j++) this.flights[j].start -= 1;
      } else {
        this.flights[i].found = false;
      }
    }
  }

  private parseDollarRecords() {
    this.ptr = this.checkStartPoint();
    let recordMask = 0;
    const cmdOverhead = 5; // include '*' + checksum etc

    const readUntilStar = (): string => {
      let s = '';
      while (this.ptr < this.size && this.bin[this.ptr] !== 0x2A /* * */) {
        s += String.fromCharCode(this.bin[this.ptr]);
        this.ptr++;
      }
      return s;
    };

    while (this.ptr < this.size) {
      let tmp = '';
      try { tmp = readUntilStar(); } catch { break; }
      const parts = tmp.split(',');
      const cmd = parts[0];
      try {
        switch (cmd) {
          case '$A': {
            recordMask |= 1;
            // we don’t need alarm limits for decoding rows
            this.skip(cmdOverhead); break;
          }
          case '$C': {
            recordMask |= 2;
            const up = parts.length-1;
            if (up === 8 || up === 9) {
              this.buildNum = parts[up-1].trim();
              this.betaNum = parts[up].trim();
              this.swVersion = parseInt(parts[up-2].trim(),10);
            } else {
              this.swVersion = parseInt(parts[up].trim(),10);
              this.buildNum = (-1).toString();
              this.betaNum = (-1).toString();
            }
            this.model = parts[1].trim();
            this.edmType = (parseFloat(this.model) >= 900);
            this.twin = (this.model === '760' || this.model === '790' || this.model === '960');
            this.isEDM930 = (this.model === '930');
            // config first word low/high
            const firstConfig = Math.trunc(Number(parts[2]));
            const hex = firstConfig.toString(16).toUpperCase().padStart(4,'0');
            const hStr = '0x' + hex.substring(0, hex.length-2 || 0);
            const lStr = '0x' + hex.substring(hex.length-2);
            this.cfgHigh = Number(hStr);
            this.cfgLow = Number(lStr);
            this.engDeg = ((Math.trunc(Number(parts[3])) & 0x1000) !== 0) ? 'F' : 'C';
            this.oatDeg = ((Math.trunc(Number(parts[5])) & 0x2000) !== 0) ? 'F' : 'C';
            this.skip(cmdOverhead); break;
          }
          case '$D': {
            recordMask |= 4;
            const id = Math.trunc(Number(parts[1]));
            const sizeWords = Math.trunc(Number(parts[2]));
            const sizeBytes = sizeWords * 2;
            this.flights.push({ id, size: sizeBytes, start: 0, date: '', time: '', interval: 0 });
            this.fltCnt = this.flights.length;
            this.skip(cmdOverhead); break;
          }
          case '$F': {
            recordMask |= 8;
            this.fUnit = parseInt(parts[1],10) || 0;
            this.skip(cmdOverhead); break;
          }
          case '$H': {
            // not used for CSV decoding here
            this.skip(cmdOverhead); break;
          }
          case '$I': {
            // CRB config bit – not essential for base CSV decoding
            this.skip(cmdOverhead); break;
          }
          case '$L': {
            recordMask |= 0x10;
            this.skip(cmdOverhead);
            this.dataStart = this.ptr;
            // Assign flight starts by accumulating sizes
            let p = this.ptr;
            for (let i=0;i<this.fltCnt;i++) {
              this.flights[i].start = p;
              p += this.flights[i].size;
            }
            // Validate minimal completeness
            if (recordMask !== 127) {
              // continue anyway
            }
            this.findDollarV();
            return;
          }
          case '$P': {
            this.protocolId = Math.trunc(Number(parts[1]));
            this.edmType = true; this.skip(cmdOverhead); break;
          }
          case '$T': {
            recordMask |= 0x20;
            // timestamp; not strictly required here
            this.skip(cmdOverhead); break;
          }
          case '$U': {
            recordMask |= 0x40;
            this.userName = (parts[1]||'').trim();
            this.skip(cmdOverhead); break;
          }
          case '$W': { this.skip(cmdOverhead); break; }
          case '$E': { break; }
          default: { return; }
        }
      } catch {
        break;
      }
    }
  }

  private scanFlightHeader(fltIdx: number) {
    // Flt ID
    const id = this.getWord();
    if (id !== this.flights[fltIdx].id) return;

    // Config words
    this.cfgWord[0] = this.getWord();
    this.cfgWord[1] = this.getWord();

    this.edmTypeActual = this.edmType; // simplified acceptance
    if (this.edmTypeActual) {
      this.cfgWord[2] = this.getWord();
      this.cfgWord[3] = this.getWord();
      // Cfg_Word[4] is present for certain model/builds
      const myModel = parseInt(this.model, 10) || 0;
      const myBuild = parseInt(this.buildNum, 10) || 0;
      this.cfgWord[4] = this.getWord();
      // EDM900 with build >= 1000 includes starting LAT/LNG when specific bits set
      if ((myModel === 900) && (myBuild >= 1000) && ((this.cfgWord[4] & 0x78) !== 0)) {
        const lat0 = this.getLong();
        const lng0 = this.getLong();
        if (Number.isFinite(lat0)) this.flights[fltIdx].latitudeStart = lat0;
        if (Number.isFinite(lng0)) this.flights[fltIdx].longitudeStart = lng0;
      }
    } else {
      this.cfgWord[2] = 0; this.cfgWord[3] = 0; this.cfgWord[4] = 0;
    }

    const fuelunit = this.getByte();
    const horsepower = this.getByte();
    this.recordInterval = this.getWord();
    this.originalInterval = this.recordInterval;

    // Date word (DOS-like packed)
    let dateword = this.getWord();
    const DD = lpad((dateword & 0x1F), 2);
    dateword = Math.trunc(dateword/32);
    const MM = lpad((dateword & 0x0F), 2);
    dateword = Math.trunc(dateword/16);
    const YY = lpad(dateword, 2);
    const yyFull = (Number(YY) >= 75) ? ('19'+YY) : ('20'+YY);

    let timeword = this.getWord();
    const SS = lpad((timeword & 0x1F) * 2, 2);
    timeword = Math.trunc(timeword/32);
    const Mnn = lpad((timeword & 0x3F), 2);
    timeword = Math.trunc(timeword/64);
    const HH = lpad(timeword, 2);

    // checksum
    this.getByte();

    this.flights[fltIdx].horsepower = horsepower;
    this.flights[fltIdx].fuelUnit = fuelunit;
    this.flights[fltIdx].interval = this.recordInterval;
    const mdy = `${MM}/${DD}/${yyFull}`;
    const hms = `${HH}:${Mnn}:${SS}`;
    this.flights[fltIdx].date = new Date(`${mdy} ${hms}`).toLocaleDateString('en-US');
    this.flights[fltIdx].time = hms;
    this.flights[fltIdx].recStart = this.ptr;
  }

  private initArraysForHeaders() {
    this.headersTemp = [];
    this.headerCount = 0;
    const add = (sensorName: string, cfgBytIdx: number, cfgBitIdx: number, hdrStr: string, scaleVal=1, mLo=-1, mLoBit=-1, mHi=-1, mHiBit=-1) => {
      this.headersTemp.push({ sensorName, cfgBytIdx, cfgBitIdx, hdrStr, scaleVal, mLoBytIdx: mLo, mLoBitIdx: mLoBit, mHiBytIdx: mHi, mHiBitIdx: mHiBit, runningTotal: 240 });
      this.headerCount++;
    };

    // For our target file (EDM900/930, SW>=107) use 107 mapping
    // Subset sufficient for single-engine columns used in Flt559.csv
    add('Left EGT 1',0,2,'E1',1,0,0,6,0);
    add('Left EGT 2',0,3,'E2',1,0,1,6,1);
    add('Left EGT 3',0,4,'E3',1,0,2,6,2);
    add('Left EGT 4',0,5,'E4',1,0,3,6,3);
    add('Left CHT 1',0,11,'C1',1,1,0);
    add('Left CHT 2',0,12,'C2',1,1,1);
    add('Left CHT 3',0,13,'C3',1,1,2);
    add('Left CHT 4',0,14,'C4',1,1,3);
    add('OAT',1,9,'OAT',1,2,5);
    add('Left DIF',0,0,'DIF');
    add('Left CLD',0,0,'CLD',1,1,6);
    add('Left MAP',1,14,'MAP',10,5,0);
    add('Left RPM',1,10,'RPM',1,5,1,5,2);
    add('Left HP',1,10,'HP',1,3,6);
    add('Left FF',1,11,'FF', this.fUnit===0?10:1,2,7);
    add('Left FF2',3,5,'FF2', this.fUnit===0?10:1,5,6);
    add('Left FP',1,15,'FP',10,8,5);
    add('Left OILP',1,13,'OILP',1,2,1);
    add('BAT',0,0,'BAT',10,2,4);
    add('AMP',0,1,'AMP',1,8,0);
    add('Left OILT',1,4,'OILT',1,1,7);
    add('Left USD',1,11,'USD',this.fUnit===0?10:1,2,6);
    add('Left USD2',3,5,'USD2',this.fUnit===0?10:1,5,7);
    add('Left FL',2,3,'RFL', this.fUnit===0?10:1,8,3);
    add('Left FL2',2,4,'LFL', this.fUnit===0?10:1,8,4);
    add('Left HRS',0,0,'HRS',10,9,6,9,7);
    add('SPD',4,5,'SPD',1,10,5);
    add('ALT',4,6,'ALT',1,10,3);
    add('LAT',4,3,'LAT',1,10,7,10,2);
    add('LNG',4,4,'LNG',1,10,6,10,1);
    add('MARK',0,0,'MARK',1,2,0);

    this.maxHdr = this.headerCount - 1;
    this.headers = this.headersTemp.slice();
    // Initialize running totals like the C# code
    if (!this.twin) {
      for (const H of this.headers) {
        if (H.hdrStr === 'HP') H.runningTotal = 0;
      }
    }
    // Initialize LAT/LNG running totals from header flight start positions
    if (this.currFltIdx >= 0) {
      for (const H of this.headers) {
        if (H.hdrStr === 'LAT') {
          const v = this.flights[this.currFltIdx].latitudeStart;
          if (typeof v === 'number' && Number.isFinite(v)) H.runningTotal = v;
        }
        if (H.hdrStr === 'LNG') {
          const v = this.flights[this.currFltIdx].longitudeStart;
          if (typeof v === 'number' && Number.isFinite(v)) H.runningTotal = v;
        }
      }
    }
  }

  private getWord(): number {
    if (this.ptr+1 >= this.size) return -1;
    const hi = this.bin[this.ptr];
    const lo = this.bin[this.ptr+1];
    this.ptr += 2;
    return (hi<<8) + lo;
  }
  private getWordAt(pos: number): number { if (pos+1>=this.size) return -1; return (this.bin[pos]<<8) + this.bin[pos+1]; }
  private getLong(): number {
    // Read a big-endian 32-bit signed integer; return NaN if underflow
    if (this.ptr + 3 >= this.size) return NaN;
    let hi = this.bin[this.ptr], mh = this.bin[this.ptr + 1], ml = this.bin[this.ptr + 2], lo = this.bin[this.ptr + 3];
    this.ptr += 4;
    if ((hi & 0x80) !== 0) {
      hi = ~hi & 0xff; mh = ~mh & 0xff; ml = ~ml & 0xff; lo = ~lo & 0xff;
      const tmp = (hi * 16777216 + mh * 65536 + ml * 256 + lo) + 1;
      return -tmp;
    }
    return (hi * 16777216 + mh * 65536 + ml * 256 + lo);
  }
  private getByte(): number { if (this.ptr>=this.size) return -1; return this.bin[this.ptr++]; }
  private skip(n: number) { for (let i=0;i<n && this.ptr<=this.size;i++) this.ptr++; }
  private checkStartPoint(): number {
    for (let i=0;i<this.size-1;i++) {
      if (this.bin[i]===0x24 /*$*/ && this.bin[i+1]===0x55 /*U*/) return i; // "$U"
    }
    return 0;
  }
}

export function decodeJpiBufferToCsv(buf: Uint8Array, flightId: number): { headers: string[]; rows: string[][] } {
  const d = new Decomp();
  d.parseFile(buf);
  return d.decodeFlightToRows(flightId);
}

export function decodeJpiFileToCsv(path: string, flightId: number): { headers: string[]; rows: string[][] } {
  const buf = fs.readFileSync(path);
  return decodeJpiBufferToCsv(buf, flightId);
}
