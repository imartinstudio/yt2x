---
name: clip-integrity-rule
description: Video clips must end at natural sentence boundaries, not cut mid-speech — derived from a real bug
metadata:
  type: project
---

When cutting video clips for the deconstruct/clips pipeline, the end timecode must always align with a natural sentence boundary in the SRT subtitles. A clip that cuts mid-sentence or before the punchline delivers an incomplete experience.

**Why:** A custom-skill clip was trimmed from 69s to 46s to save length, but the cut landed right before the demonstration result ("试试这个Skill的效果"). The viewer never saw the actual Skill output. The same happened with a Computer Use clip that cut before the key line "你完全可以让它在后台默默干活".

**How to apply:**

1. LLM deconstruct prompt already has the rule: end timecodes must align with SRT sentence boundaries.
2. `generator.ts:validateClipEndings()` checks all candidates against SRT and warns if a clip ends mid-entry or without ending punctuation. This runs during `yt2x deconstruct`.
3. AGENTS.md has a section "视频裁剪规则" with the same rules.
4. When in doubt, prefer longer clips over shorter. Over-length can be trimmed manually.
