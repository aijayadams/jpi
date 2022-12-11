use std::{fs, path::Path, str};

struct EdmHeader {
    parsed: bool,
    file_name: &'static str,
    file_stream: Vec<u8>,
}

impl EdmHeader {
    fn new(file_path: &'static str) -> Result<EdmHeader, Box<dyn std::error::Error>> {
        Ok(EdmHeader {
            file_name: file_path,
            file_stream: EdmHeader::read_file(file_path)?,
            parsed: false,
        })
    }

    const START: u8 = b'$';
    const END: u8 = b'*';

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
    fn parse(&self) {
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
        dbg!(header
            .lines()
            .map(EdmHeader::checksum)
            .collect::<Vec<bool>>());
    }

    fn is_parsed(&self) -> bool {
        self.parsed
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let header: EdmHeader = EdmHeader::new("./FILE.JPI")?;

    dbg!(header.is_parsed());
    dbg!(header.parse());
    Ok(())
}
