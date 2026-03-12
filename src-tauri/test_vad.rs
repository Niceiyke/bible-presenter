use webrtc_vad::{Vad, VadMode};
fn main() {
    let mut vad = Vad::new();
    vad.set_mode(VadMode::Aggressive);
    let buf = vec![0i16; 160];
    let _ = vad.is_voice_segment(&buf);
}
