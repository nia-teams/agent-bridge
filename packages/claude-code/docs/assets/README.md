# Product screenshot assets

These PNGs are captured from the Nia Teams web application's unchanged React routes,
served locally with Vite and isolated fictional HTTP/stream responses. No live Agent
or backend session is used. Chromium renders at `deviceScaleFactor: 2` with a light
color scheme, Chinese locale, and Asia/Shanghai timezone.

| Asset | Browser viewport | Capture |
| --- | --- | --- |
| `group-chat-overview.png` | 1280 × 540 CSS px | Full GroupChat route |
| `agent-pairing.png` | 760 × 690 CSS px | Full external Agent pairing route |
| `taskbar-approval.png` | 1280 × 540 CSS px | Card-bound crop including activity and composer |

Fixtures use Alice, Acme, Production Ops, `claude-host`, and
`claude@alice-macbook`. The external Agent avatar response is a neutral terminal
icon. The TaskBar card presents `Allow Bash?`, the Claude Code permission summary,
and the argument preview `{"command":"npm test"}`. The pairing code is a
nonfunctional fixture value. Dates are fixed for consistent relative timestamps.

Capture the original rendered UI, not a recreated HTML layout or an image edit.
Review every image for complete controls, nearby composer context, clean crop
boundaries, and readable text before replacing these assets.
