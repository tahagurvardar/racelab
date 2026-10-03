//! Little-endian field reader over a datagram the classifier has already
//! accepted at its exact specification size. Every read stays inside that
//! size by construction (a car slot is chosen only after `index < 22`), so
//! the slice indexing here cannot go out of bounds.
use super::Wheels;

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8], at: usize) -> Self {
        Self { bytes, at }
    }

    fn take<const N: usize>(&mut self) -> [u8; N] {
        let value = self.bytes[self.at..self.at + N]
            .try_into()
            .expect("N bytes");
        self.at += N;
        value
    }

    pub fn position(&self) -> usize {
        self.at
    }
    pub fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    pub fn i8(&mut self) -> i8 {
        i8::from_le_bytes(self.take())
    }
    pub fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take())
    }
    pub fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }
    pub fn i16(&mut self) -> i16 {
        i16::from_le_bytes(self.take())
    }
    pub fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take())
    }
    pub fn f64(&mut self) -> f64 {
        f64::from_le_bytes(self.take())
    }
    pub fn bytes<const N: usize>(&mut self) -> [u8; N] {
        self.take()
    }
    pub fn wheels<T: Copy>(&mut self, mut read: impl FnMut(&mut Self) -> T) -> Wheels<T> {
        let a = read(self);
        let b = read(self);
        let c = read(self);
        let d = read(self);
        Wheels::from_wire([a, b, c, d])
    }
}
