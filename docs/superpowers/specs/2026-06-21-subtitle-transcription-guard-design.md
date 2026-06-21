# Subtitle transcription guard design

## Goal

Prevent a malformed local Whisper transcription from being silently translated and burned into a video, and make a forced rerun regenerate derived subtitle assets.

## Design

The acquire adapter will validate only locally transcribed SRT files after cleanup. A transcription with a long contiguous run of the same non-empty cue is treated as a failed transcription and stops the subtitle stage before translation or burning. This targets Whisper language-forcing hallucinations without rejecting ordinary repeated phrases that are separated by other dialogue.

Translation will use the source language recorded in the subtitle manifest, because it is the pipeline's detected source language. A user-declared language remains the Whisper hint, but it must not override the detected language sent to the translation model.

When `force` is set, the pipeline will remove the previous generated target SRT before deciding whether translation is needed. The source SRT is then recreated and the burned MP4 is regenerated from the new target SRT.

## Error handling

The repeated-cue check throws an actionable error that identifies local transcription and recommends verifying `--subtitle-source-lang` or using `auto`. It does not produce a target SRT or burned video.

## Tests

- A repeated local-transcription SRT is rejected before target subtitle generation.
- Repeated non-adjacent cues are accepted.
- Translation is called with the manifest's detected source language.
- `force` replaces a pre-existing target SRT rather than reusing it.
