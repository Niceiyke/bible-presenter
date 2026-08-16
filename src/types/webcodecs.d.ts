/**
 * Ambient WebCodecs stream-processing types missing from TS's lib.dom for the
 * TypeScript version used here. `MediaStreamTrackProcessor` lets WebCodecs
 * consume `VideoFrame`s / `AudioData` directly from a `MediaStream` track
 * without a `<video>`/`<audio>` round-trip — used by the RTMP encoder
 * (`useRtmpEncoder`).
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

interface MediaStreamTrackProcessor<T = VideoFrame | AudioData> {
  readonly readable: ReadableStream<T>;
}

declare class MediaStreamTrackProcessor<T = VideoFrame | AudioData> implements MediaStreamTrackProcessor<T> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}