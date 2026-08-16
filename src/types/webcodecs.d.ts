/**
 * Ambient WebCodecs stream-processing types missing from TS's lib.dom for the
 * TypeScript version used here. `MediaStreamTrackProcessor` lets WebCodecs
 * consume `VideoFrame`s directly from a `MediaStream` track without a
 * `<video>` round-trip — used by the RTMP encoder (`useRtmpEncoder`).
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

interface MediaStreamTrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
}

declare class MediaStreamTrackProcessor implements MediaStreamTrackProcessor {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<VideoFrame>;
}