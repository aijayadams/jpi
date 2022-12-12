use std::{default, fs, path::Path, str};

#[derive(Debug, Default)]
struct Alarms {
    min_volts: Option<f64>,
    max_volts: Option<f64>,
    max_egt_spread: Option<i32>,
    max_cht: Option<i32>,
    max_cht_cool_rate: Option<i32>,
    max_egt: Option<i32>,
    min_oil_temp: Option<i32>,
    max_oil_temp: Option<i32>,
}
#[derive(Debug)]

enum FuelFlowUnits {
    GPH,
    PPH,
    LPH,
    KPH,
}
#[derive(Debug)]
enum TempUnits {
    Farenheit,
    Celcius,
}

#[derive(Debug, Default)]
struct Fuel {
    fuel_flow_units: Option<FuelFlowUnits>,
    full_level: Option<i32>,
    warning_level: Option<i32>,
    k_factor_ff1: Option<i32>,
    k_factor_ff2: Option<i32>,
}

#[derive(Debug, Default)]
struct Sensors {
    egt_count: Option<i32>,
    cht_count: Option<i32>,
    volts: bool,
    oil_temp: bool,
    tit1: bool,
    tit2: bool,
    oat: bool,
    fuel_flow: bool,
    iat: bool,
    cdt: bool,
    map: bool,
    rpm: bool,
}

#[derive(Debug, Default)]
struct Features {
    model: Option<i32>,
    firmware_version: Option<i32>,
    sensors: Option<Sensors>,
    engine_temperature_unit: Option<TempUnits>,
    unknown1: Option<i32>,
    unknown2: Option<i32>,
}

#[derive(Debug, Default)]
struct HeaderData {
    registration: Option<String>,
    alarms: Option<Alarms>,
    fuel: Option<Fuel>,
    download_time: Option<i64>,
    protocol_version: Option<i32>,
    features: Option<Features>,
}

struct EdmHeader {
    parsed: bool,
    file_name: &'static str,
    file_stream: Vec<u8>,
    data: Option<HeaderData>,
}

impl EdmHeader {
    fn new(file_path: &'static str) -> Result<EdmHeader, Box<dyn std::error::Error>> {
        Ok(EdmHeader {
            file_name: file_path,
            file_stream: EdmHeader::read_file(file_path)?,
            parsed: false,
            data: None,
        })
    }

    const START: u8 = b'$';
    const END: u8 = b'*';
    const DELIM: char = ',';

    fn read_file(file_path: &'static str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        Ok(fs::read(Path::new(file_path))?)
    }

    fn len(&self) -> usize {
        self.file_stream.len()
    }

    fn checksum(header_line: &str) -> bool {
        let (value, checksum_s) = header_line
            .split_once(EdmHeader::END as char)
            .expect("Checksum not found");
        let checksum = u8::from_str_radix(checksum_s, 16).expect("Could not read checksum");
        let calc_checksum = value.as_bytes()[1..].iter().fold(0, |i, x| i ^ *x);
        calc_checksum == checksum
    }
    fn parse(&self) -> &str {
        // Find where the header ends
        let header_term = self
            .file_stream
            .windows(2)
            .enumerate()
            .find(|(_, v)| v[0] == b'\n' && v[1] != EdmHeader::START)
            .map(|(i, _)| i)
            .expect("Could not find end of header!");

        // Header is in ascii for some reason
        let header = str::from_utf8(&self.file_stream[..header_term])
            .expect("Could not parse header as utf8");

        // Validate header checksums
        header
            .lines()
            .map(EdmHeader::checksum)
            .collect::<Vec<bool>>();

        header
    }

    fn process_header_clean(header_line: &str) -> Vec<String> {
        let (data, _) = header_line
            .split_once(EdmHeader::END as char)
            .expect("Checksum not found");
        data.split(EdmHeader::DELIM)
            .enumerate()
            .filter_map(|(i, v)| {
                if i != 0 {
                    Some(v.trim().to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<String>>()
    }

    fn process_header_rego(header_line: &str) -> Option<String> {
        let reg = EdmHeader::process_header_clean(header_line);
        if reg.len() == 1 {
            Some(reg[0].clone().to_string())
        } else {
            None
        }
    }

    fn process_header_alarms(header_line: &str) -> Option<Alarms> {
        let mut alarms = EdmHeader::process_header_clean(header_line);
        let mut alarms_itr = alarms.iter_mut();
        Some(Alarms {
            max_volts: Some(
                alarms_itr
                    .next()?
                    .parse::<f64>()
                    .expect("Could not parse alarm")
                    / 10.0,
            ),
            min_volts: Some(
                &alarms_itr
                    .next()?
                    .parse::<f64>()
                    .expect("Could not parse alarm")
                    / 10.0,
            ),
            max_egt_spread: Some(
                alarms_itr
                    .next()?
                    .parse::<i32>()
                    .expect("Could not parse alarm"),
            ),
            max_cht: Some(
                alarms_itr
                    .next()?
                    .parse::<i32>()
                    .expect("Could not parse alarm"),
            ),
            max_cht_cool_rate: Some(
                alarms_itr
                    .next()?
                    .parse::<i32>()
                    .expect("Could not parse alarm"),
            ),
            max_egt: Some(
                alarms_itr
                    .next()?
                    .parse::<i32>()
                    .expect("Could not parse alarm"),
            ),
            max_oil_temp: Some(
                alarms_itr
                    .next()?
                    .parse::<i32>()
                    .expect("Could not parse alarm"),
            ),
            min_oil_temp: Some(
                alarms_itr
                    .next()?
                    .parse::<i32>()
                    .expect("Could not parse alarm"),
            ),
            ..Default::default()
        })
    }

    fn data(&self) -> HeaderData {
        let headers = self.parse();
        let mut header_data = HeaderData {
            ..Default::default()
        };
        for line in headers.lines() {
            match line.chars().nth(1).expect("Empty Header!") {
                'U' => {
                    header_data.registration = EdmHeader::process_header_rego(line);
                }
                'A' => {
                    header_data.alarms = EdmHeader::process_header_alarms(line);
                }
                _ => (),
            }
        }
        header_data
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let header: EdmHeader = EdmHeader::new("./FILE.JPI")?;

    dbg!(header.data());
    Ok(())
}
