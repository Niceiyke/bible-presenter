/**
 * Ambient WebCodecs stream-processing types missing from TS's lib.dom for the
 * TypeScript version used here. `MediaStreamTrackProcessor` lets WebCodecs
 * consume `VideoFrame`s / `AudioData` directly from a `MediaStream` track
 * without a `<video>`/`<audio>` round-trip — still used by the system
 * diagnostics H.264 capability probe (`src/system/SystemDiagnosticsContext.tsx`).
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