import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

/**
 * Seed anchored comments before the app mounts.
 *
 * The workbench reads its review out of localStorage at mount, so a comment
 * written by the UI would have to survive a harder path than this test needs -
 * the composer lives inside a possibly-collapsed card behind a docked panel.
 * Seeding the store exercises the half that matters here: `loadComments` ->
 * `readAnchor` -> the anchor table -> a cloud on the model.
 *
 * The key is the real `decisionKey` shape: part_id, check_name and index joined
 * by NUL, which is what the viewer's anchor table produces.
 */
await page.addInitScript(() => {
  const key = ['Riser_Pipe_Main_01', 'Riser pipe outer diameter must be 100 mm', 0].join('\u0000');
  const comment = (id, body, anchor) => ({
    id,
    author: 'QC Anna',
    role: 'Quality Controller',
    body,
    createdAt: new Date().toISOString(),
    anchor,
  });
  localStorage.setItem(
    'cad-auditor.comments.v1',
    JSON.stringify({
      [key]: [
        comment('c1', 'This bore reads undersized on site.', [1.40625, 6.302083333333336, -25]),
        comment('c2', 'Agreed — recheck the DN after the reroute.', [1.40625, 6.302083333333336, -25]),
        comment('c3', 'Third opinion: measure again after install.', [1.40625, 6.302083333333336, -25]),
      ],
    }),
  );
});

await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
await page.getByText('Demo Skid', { exact: false }).first().click({ timeout: 15000 });
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Validate and Run Audit' }).click({ timeout: 15000 });
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  if ((await page.locator('canvas').count()) > 0 &&
      (await page.getByText(/Running|Auditing|Extracting|Validating/i).count()) === 0) break;
}
await page.waitForTimeout(9000);

const cards = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="finding-beacon"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.dataset.findingId,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  }),
);
console.log('MARKERS:', cards.length);
cards.slice(0, 5).forEach((c) => console.log(`  #${c.id} @(${c.x},${c.y})  "${c.text}"`));

// Every marker must sit clear of the docked inspector, which is 460px wide and
// painted over the canvas at a higher z-index than the marker layer.
const inspectorOpen = (await page.getByText('Feedback & AutoReview').count()) > 0;
const unsafe = cards.filter((c) => inspectorOpen && c.x < 460);
console.log('MARKERS UNDER THE INSPECTOR:', unsafe.length);

const clouds = page.locator('[data-testid="comment-cloud"]');
const cloudCount = await clouds.count();
console.log('COMMENT CLOUDS:', cloudCount);

if (cloudCount > 0) {
  const cloud = clouds.first();
  console.log('  badge count:', await cloud.getAttribute('data-count'));
  const box = await cloud.boundingBox();
  console.log('  badge at:', Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  // The badge must be inside the visible band, not clipped behind the panel.
  console.log('  badge clear of inspector:', box.x >= 460);

  // Opening a cloud shows its comments and does not move the camera - the
  // flight belongs to the marker path, which the cloud routes through.
  await cloud.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await page.waitForTimeout(1200);
  const card = page.locator('[data-testid="comment-cloud-card"]');
  console.log('  cloud card open:', await card.count());
  if (await card.count()) {
    const text = (await card.first().innerText()).replace(/\n+/g, ' | ');
    console.log('  card text:', text.slice(0, 160));
    const cb = await card.first().boundingBox();
    console.log('  card fully visible:', cb.x >= 460 && cb.x + cb.width <= 1600 - 340 + 1);
  }
}

await page.screenshot({ path: 'D:/3D-project-AE/screenshots/comment-clouds.png' });
console.log('errors:', errors.length ? errors.slice(0, 6).join('\n') : '(none)');
await browser.close();
