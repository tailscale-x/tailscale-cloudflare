# Control UI design QA

Reference direction: selected second ideation direction, a light topology-led
operations console. The reference image is kept in the product-design working
area at `/home/ubuntu/.codex/generated_images/01a0fb67-cb0a-7753-bcaf-61cb404a16d6/exec-d09f3a9b-88d3-48de-8167-1c2745fb2d4d.png`.

Implementation evidence: `docs/screenshots/control-dashboard-v1.png`.

## Checks

- Desktop viewport: 1440×1024, light color scheme.
- Sidebar groups Overview, Infrastructure, Access, and Operations and marks the
  current route.
- Dashboard has the four health summaries, control-to-exposure topology, next
  step panel, audit activity, tailnet identity, and ownership sync state.
- Navigation and infrastructure symbols use embedded Tabler outline assets.
- Mobile viewport: 390×844. The sidebar collapses behind the menu control,
  topology cards stack, tables use labeled rows, command blocks wrap, and the
  document scroll width equals the viewport width (390px).
- Keyboard focus is visible and status text is available in the accessibility
  tree. Credentials are not rendered in the synthetic preview.
- Provider, zone, policy, enrollment, exposure, and operations routes retain
  their existing API actions and ownership/authentication behavior.

## Result

final result: passed
