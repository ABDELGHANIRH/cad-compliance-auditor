Please apply the following 5 fixes across the codebase:

1. In `frontend/src/components/CADViewer.tsx`:
   - Move `ViewportControls` container from `top-3` to `top-14` so it stops colliding with the Inspector button.
   - Switch the theme from dark holographic to light studio:
     - Set `STAGE_BACKDROP = '#F8FAFC'` and `STAGE_BACKDROP_NEAR = '#FFFFFF'`.
     - In `makeMaterials`, use standard non-emissive studio metal/roughness materials.
     - In `ViewportScene`, update `<Grid>` colors to subtle grey `#CBD5E1` and `#94A3B8`.
   - In `FindingBubble`, widen `BUBBLE_WIDTH` to 290 and remove `line-clamp-2` and `truncate` so comments are fully readable.
   - In `AnchorBeacon` and `DefectCallout`, add `onClick` handlers forwarding `onOpenFinding(partId, checkIndex)` so 3D in-scene markers are directly clickable on the model.

2. In `frontend/src/app/api/copilot/route.ts`:
   - Update the DeepSeek completions handler to safely parse `data.choices?.[0]?.message?.content` and return descriptive error messages if the API key is missing or calls fail.

Run `cd frontend && npx tsc --noEmit` to verify type safety when done.