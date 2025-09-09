export interface FlightRecord {
  id: number;
  size: number; // bytes, in file
  start: number; // offset to start of flight data
  date: string; // MM/DD/YYYY
  time: string; // HH:mm:ss
  interval: number; // seconds
  duration?: string; // hours string
  fuelUnit?: number;
  horsepower?: number;
  recStart?: number;
  recCount?: number;
  found?: boolean;
  latitudeStart?: number; // encoded
  longitudeStart?: number; // encoded
}

export interface DecodeResultMeta {
  model: string;
  swVersion: number;
  buildNum: string;
  betaNum: string;
  twin: boolean;
  edmType: boolean;
  engDeg: 'C' | 'F';
  oatDeg: 'C' | 'F';
  createdWith?: string;
  userName?: string;
}

export interface HeadersRows {
  headers: string[];
  rows: string[][]; // Columns: DATE,TIME,FM,... per header order
}

export interface DecodeAPI {
  parseFile(buf: Uint8Array): void;
  listFlights(): FlightRecord[];
  openFlight(flightId: number): string[]; // returns headers (DATE,TIME,FM, ...)
  readRecord(dateStr: string): string | undefined; // returns CSV row string or undefined at EOF
  decodeFlightToRows(flightId: number): HeadersRows;
}

export interface FlightSummary {
  id: number;
  // Date of the flight (MM/DD/YYYY). Time components are provided separately.
  dateTime: string; // "MM/DD/YYYY"
  // Clock times at first and last sample for the flight
  timeOff?: string; // "HH:mm:ss"
  timeIn?: string;  // "HH:mm:ss"
  samples: number;
  tachStart?: number;
  tachEnd?: number;
  tachDuration?: number; // hours
  hobbDuration?: number; // hours from first to last sample time
  startLat?: string; // e.g., N39.04.05
  startLng?: string; // e.g., W094.53.86
  endLat?: string;
  endLng?: string;
}
