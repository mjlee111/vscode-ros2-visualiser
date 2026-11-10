// Captures README screenshots from the dev harness (demo_sensors.py must be running).
//   node scripts/screenshots.mjs [outDir=media/screenshots] [name ...]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'fs';

const base = process.env.HARNESS_URL ?? 'http://localhost:8765';
const out = process.argv[2] ?? 'media/screenshots';
const only = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function shot(name, view, args, prepare) {
  if (only.length && !only.includes(name)) return;
  const page = await ctx.newPage();
  await page.goto(`${base}/view/${view}${args ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''}`);
  await page.waitForTimeout(2500);
  if (prepare) await prepare(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
  await page.close();
}

await shot('graph', 'graph', null, async (p) => {
  await p.waitForFunction(() => window.__cy?.nodes('.rosnode').length >= 4);
  await p.waitForTimeout(400);
});
await shot('topics', 'topics', { topic: '/demo/pose' }, async (p) => {
  await p.click('text=Monitor all');
  await p.waitForTimeout(3500);
});
await shot('image', 'image', { topic: '/demo/camera/depth' }, (p) => p.waitForTimeout(1500));
await shot('pointcloud', 'pointcloud', { topic: '/demo/points' }, (p) => p.waitForTimeout(1500));
await shot('plot', 'plot', { topic: '/demo/sine', field: 'data' }, async (p) => {
  for (const [t, f] of [['/demo/cosine', 'data'], ['/demo/sine_filtered', 'data']]) {
    await p.fill('input[list="topics-dl"]', t);
    await p.fill('input[list="fields-dl"]', f);
    await p.click('text=+ Add');
  }
  await p.selectOption('select[title="Time window"]', '10');
  await p.waitForTimeout(9000);
});
await shot('urdf', 'urdf', null, async (p) => {
  await p.waitForFunction(() => window.__urdf?.getModel()?.pending === 0 && window.__urdf.getModel().links.size > 0);
  await p.waitForTimeout(1500);
  const xy = await p.evaluate(() => {
    const u = window.__urdf;
    const v = u.getModel().links.get('torso').getWorldPosition(new u.camera.position.constructor());
    v.z += 0.2;
    v.project(u.camera);
    const r = document.querySelector('canvas').getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  });
  await p.mouse.click(xy[0], xy[1]);
  await p.mouse.move(5, 5);
  await p.waitForTimeout(500);
});
await shot('tf', 'tf', null, async (p) => {
  await p.waitForFunction(() => window.__cy?.nodes().length >= 6);
  await p.selectOption('select[title="target frame"]', 'base_link');
  await p.selectOption('select[title="source frame"]', 'camera_optical');
  await p.evaluate(() => window.__cy.getElementById('camera_optical').emit('tap'));
  await p.waitForTimeout(400);
});
await shot('console', 'console', null, (p) => p.waitForTimeout(4000));
await shot('service', 'service', { service: '/demo/add_two_ints' }, async (p) => {
  await p.fill('textarea', '{\n  "a": 2,\n  "b": 40\n}');
  await p.click('text=▶ Call');
  await p.waitForTimeout(800);
});
await shot('params', 'params', { node: '/demo/demo_sensors' }, (p) => p.waitForTimeout(800));
await browser.close();
