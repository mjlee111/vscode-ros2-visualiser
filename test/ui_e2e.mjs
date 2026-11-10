// Interactive UI test of the webviews through the dev harness (headless Chrome).
// Requires: harness on HARNESS_URL (default http://localhost:8765) and demo_sensors.py
// running in the same isolated ROS domain.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'fs';

const base = process.env.HARNESS_URL ?? 'http://localhost:8765';
const shots = process.argv[2] ?? 'test-shots';
mkdirSync(shots, { recursive: true });
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  -> ${detail}`}`);
  if (!cond) fails.push(name);
};
async function open(view, args) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`${base}/view/${view}${args ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''}`);
  return page;
}

// ---- service caller -------------------------------------------------------
{
  const p = await open('service', { service: '/demo/add_two_ints' });
  await p.waitForSelector('textarea');
  await p.fill('textarea', '{"a": 2, "b": 40}');
  await p.click('text=▶ Call');
  await p.waitForSelector('.msgtree .tv-number', { timeout: 8000 });
  const sum = await p.textContent('.msgtree');
  check('service call returns sum 42', /sum: ?42/.test(sum.replace(/\s+/g, ' ')), sum);
  check('service history row', (await p.locator('table.grid tr').count()) >= 1);
  await p.fill('textarea', '{"a": "oops"}');
  await p.click('text=▶ Call');
  await p.waitForSelector('.err', { timeout: 8000 });
  check('service bad request shows error', (await p.textContent('.err')).length > 0);
  check('service no page errors', !p.errors.length, p.errors.join('\n'));
  await p.screenshot({ path: `${shots}/e2e-service.png` });
  await p.close();
}

// ---- publisher -> topic monitor echo ------------------------------------
{
  const p = await open('publisher');
  await p.waitForTimeout(1500);
  await p.fill('input[placeholder="/topic"]', '/vis_e2e/value');
  await p.fill('input[placeholder="pkg/msg/Type"]', 'std_msgs/msg/Float64');
  await p.fill('input[title^="Hz"]', '20');
  await p.click('text=+ Add publisher');
  await p.waitForSelector('textarea');
  await p.fill('textarea', '{"data": 3.25}');
  await p.click('button:has-text("▶ Start")');
  await p.waitForFunction(() => /[1-9]\d* sent/.test(document.body.textContent), null, { timeout: 8000 });
  check('publisher running with count', true);
  const mon = await open('topics', { topic: '/vis_e2e/value' });
  await mon.waitForFunction(() => /3\.25/.test(document.querySelector('.msgtree')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  check('topic monitor echoes published value', /3\.25/.test((await mon.textContent('.msgtree')) ?? ''));
  await mon.waitForFunction(() => /Rate\s*(1[5-9]|2[0-5])\./.test(document.body.innerText.replace(/\n/g, ' ')), null, { timeout: 8000 }).catch(() => undefined);
  const rateText = await mon.innerText('.kv');
  check('topic monitor rate ~20 Hz', /Rate\s+(1[5-9]|2[0-5])\.\d+ Hz/.test(rateText), rateText);
  // plot button on numeric leaf forwards a command (logged by harness)
  await mon.hover('.msgtree .tr:has-text("data")');
  await mon.click('.msgtree .leaf-act');
  await mon.screenshot({ path: `${shots}/e2e-topics.png` });
  // edit + apply while running
  await p.fill('textarea', '{"data": 7.5}');
  await p.click('button:has-text("Apply")');
  await mon.waitForFunction(() => /7\.5/.test(document.querySelector('.msgtree')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
  check('apply updates running publisher', /7\.5/.test((await mon.textContent('.msgtree')) ?? ''));
  await p.click('button:has-text("■ Stop")');
  await p.waitForTimeout(300);
  check('publisher stopped', /stopped/.test(await p.textContent('.badge:nth-of-type(2)')));
  check('publisher/monitor no page errors', !p.errors.length && !mon.errors.length, [...p.errors, ...mon.errors].join('\n'));
  await p.screenshot({ path: `${shots}/e2e-publisher.png` });
  await mon.close();
  await p.close();
}

// ---- parameters ------------------------------------------------------------
{
  const p = await open('params', { node: '/demo/demo_sensors' });
  await p.waitForSelector('td:has-text("label")', { timeout: 8000 });
  const input = p.locator('tr:has(td:has-text("label")) input[type=text]');
  await input.fill('changed_by_e2e');
  await input.press('Enter');
  await p.waitForSelector('.toast-ok', { timeout: 8000 }).catch(() => undefined);
  await p.click('text=⟳ Refresh');
  await p.waitForTimeout(800);
  check('param set persisted', (await p.locator('tr:has(td:has-text("label")) input[type=text]').inputValue()) === 'changed_by_e2e');
  const bad = p.locator('tr:has(td:has-text("cloud_points")) input');
  await bad.fill('1.5');
  await bad.press('Enter');
  await p.waitForTimeout(300);
  check('param invalid int rejected client-side', (await p.locator('.toast-error').count()) >= 1);
  const restore = p.locator('tr:has(td:has-text("label")) input[type=text]');
  await restore.fill('hello');
  await restore.press('Enter');
  await p.waitForTimeout(500);
  check('params no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- graph modes + selection ----------------------------------------------
{
  const p = await open('graph');
  await p.waitForFunction(() => window.__cy && window.__cy.nodes('.rosnode').length >= 4, null, { timeout: 10000 });
  const count = () => p.evaluate(() => ({ nodes: window.__cy.nodes('.rosnode').length, topics: window.__cy.nodes('.topic').length, edges: window.__cy.edges().length }));
  const mode = async (label) => {
    await p.click(`.seg button:has-text("${label}")`);
    await p.waitForTimeout(400);
  };
  await mode('Active');
  const active = await count();
  await mode('All topics');
  const all = await count();
  check('graph "all" shows more topics than "active"', all.topics > active.topics, JSON.stringify({ active, all }));
  check('one-sided topics marked', (await p.evaluate(() => window.__cy.nodes('.topic.onesided').length)) > 0);
  await mode('Nodes');
  const nodesOnly = await count();
  check('graph "nodes only" has no topic boxes', nodesOnly.topics === 0 && nodesOnly.edges >= 1, JSON.stringify(nodesOnly));
  await mode('All topics');
  const overlaps = await p.evaluate(() => {
    const bbs = window.__cy.nodes().map((n) => n.boundingBox());
    let k = 0;
    for (let i = 0; i < bbs.length; i++)
      for (let j = i + 1; j < bbs.length; j++) {
        const a = bbs[i], b = bbs[j];
        if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) k++;
      }
    return k;
  });
  check('packed layout has no overlapping nodes', overlaps === 0, overlaps);
  await p.click('button:has-text("Filters")');
  await p.check('.popover label:has-text("Group by namespace") input');
  await p.waitForTimeout(400);
  check('namespace groups', (await p.evaluate(() => window.__cy.nodes('.ns').length)) >= 1);
  await p.uncheck('.popover label:has-text("Group by namespace") input');
  await p.mouse.click(5, 300);
  await p.evaluate(() => window.__cy.getElementById('n:/demo/demo_sensors').emit('tap'));
  await p.waitForTimeout(200);
  const side = await p.innerText('.side-panel h3');
  check('node info panel', side.includes('/demo/demo_sensors'), side);
  await p.fill('input[type=search]', '/demo');
  await p.waitForTimeout(700);
  const filtered = await p.evaluate(() => window.__cy.nodes('.rosnode').map((n) => n.data('fqn')));
  check('graph filter', filtered.length >= 1 && filtered.every((f) => f.startsWith('/demo')), filtered.join(','));
  await p.fill('input[type=search]', 'zzz_nothing');
  await p.waitForTimeout(700);
  check('empty-filter notice', /Nothing matches/.test(await p.innerText('.notice')));
  await p.click('.notice button');
  await p.waitForTimeout(500);
  check('reset filters restores graph', (await p.evaluate(() => window.__cy.nodes('.rosnode').length)) >= 4);
  await p.fill('input[type=search]', '-chatter, -sine');
  await mode('Active');
  const notice = await p.innerText('.notice').catch(() => '');
  check('active-mode "no connecting topic" notice', /No topic connects two nodes/.test(notice), notice);
  await p.click('.notice button');
  await p.waitForTimeout(400);
  check('notice button switches to all topics', await p.evaluate(() => document.querySelector('.seg button.on')?.textContent === 'All topics'));
  await p.fill('input[type=search]', '');
  await p.waitForTimeout(500);
  check('graph no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- TF lookup -------------------------------------------------------------
{
  const p = await open('tf');
  await p.waitForFunction(() => window.__cy && window.__cy.nodes().length >= 6, null, { timeout: 10000 });
  await p.selectOption('select[title="target frame"]', 'base_link');
  await p.selectOption('select[title="source frame"]', 'camera_optical');
  await p.waitForTimeout(200);
  const out = await p.locator('span.mono').filter({ hasText: 't [' }).first().innerText();
  // camera_optical in base_link = (0.25, 0, 0.5), yaw -90°
  check('tf lookup composes transforms', /t \[0\.2500, 0\.0000, 0\.5000\]/.test(out) && /-90\.00\]/.test(out), out);
  check('tf no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- 3D view colour field switch -------------------------------------------
{
  const p = await open('pointcloud', { topic: '/demo/points' });
  await p.waitForFunction(() => /points [\d,]+ \//.test(document.querySelector('.statusbar')?.textContent ?? ''), null, { timeout: 10000 });
  await p.selectOption('select[title="Color by field"]', 'intensity');
  await p.waitForFunction(() => /color intensity/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, { timeout: 6000 }).catch(() => undefined);
  check('cloud recolored by intensity', /color intensity/.test(await p.textContent('.statusbar')));
  await p.screenshot({ path: `${shots}/e2e-cloud-intensity.png` });
  await p.selectOption('select[title="Color by field"]', 'auto');
  check('cloud no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- console filtering -----------------------------------------------------
{
  const p = await open('console');
  await p.waitForFunction(() => document.querySelectorAll('tbody tr').length > 5, null, { timeout: 10000 });
  await p.fill('input[placeholder^="include"]', 'tick');
  await p.waitForTimeout(300);
  const nodes = await p.$$eval('tbody tr td:nth-child(4)', (tds) => [...new Set(tds.map((t) => t.textContent))]);
  const msgs = await p.$$eval('tbody tr td:nth-child(5)', (tds) => tds.map((t) => t.textContent));
  check('console include filter', msgs.length >= 1 && msgs.every((m) => /tick/.test(m)) && nodes.every((n) => /demo_sensors/.test(n)), nodes.join(','));
  check('console no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- URDF viewer -------------------------------------------------------------
{
  const p = await open('urdf');
  await p.waitForFunction(() => window.__urdf?.getModel()?.links.size === 11 && window.__urdf.getModel().pending === 0, null, { timeout: 15000 });
  const m = () => p.evaluate(() => {
    const md = window.__urdf.getModel();
    const pos = md.linkPose('forearm');
    return { failed: md.failed, left: md.joints.get('finger_left_joint').value, right: md.joints.get('finger_right_joint').value, forearm: pos.xyz.toArray() };
  });
  const a = await m();
  check('urdf meshes (stl/obj/dae) loaded', a.failed.length === 0, a.failed.join(','));
  await p.waitForTimeout(600);
  const b = await m();
  check('urdf follows /joint_states', Math.hypot(...a.forearm.map((v, i) => v - b.forearm[i])) > 1e-3, JSON.stringify([a.forearm, b.forearm]));
  check('mimic joint', Math.abs(b.left + b.right) < 1e-9 && Math.abs(b.left) > 0, JSON.stringify(b));
  await p.waitForFunction(() => /matched\s*8\/8/.test(document.querySelector('.statusbar')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => undefined);
  check('joint names matched 8/8', /matched\s*8\/8/.test(await p.textContent('.statusbar')));
  // pick a link by clicking on the projected torso position
  const xy = await p.evaluate(() => {
    const u = window.__urdf;
    const md = u.getModel();
    const v = md.links.get('torso').getWorldPosition(new u.camera.position.constructor());
    v.z += 0.2;
    v.project(u.camera);
    const r = document.querySelector('canvas').getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  });
  await p.mouse.click(xy[0], xy[1]);
  await p.waitForTimeout(300);
  const picked = await p.locator('.side-panel h3').nth(1).textContent().catch(() => '');
  check('click inspects a link', !!picked && picked.length > 0, picked);
  await p.screenshot({ path: `${shots}/e2e-urdf.png` });
  // sliders (local) mode
  await p.selectOption('select[title="Joint positions"]', 'slider:');
  await p.waitForTimeout(300);
  const elbow = p.locator('.side-panel div:has(> div > span:text-is("elbow")) input[type=range]');
  await elbow.evaluate((el) => {
    el.value = '1.2';
    el.dispatchEvent(new Event('input'));
  });
  const ev = await p.evaluate(() => window.__urdf.getModel().joints.get('elbow').value);
  check('slider drives joint', Math.abs(ev - 1.2) < 1e-6, ev);
  await p.check('label:has-text("collision") input');
  check('collision geometry toggle', await p.evaluate(() => [...window.__urdf.getModel().collisionGroups.values()].every((g) => g.visible)));
  await p.selectOption('select[title="Joint positions"]', 'topic:/joint_states');
  check('urdf no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}
{
  const p = await open('urdf', { file: '/opt/ros/jazzy/share/robot_state_publisher/urdf/test-desc.urdf.xacro' });
  await p.waitForFunction(() => (window.__urdf?.getModel()?.links.size ?? 0) > 0, null, { timeout: 30000 }).catch(() => undefined);
  const n = await p.evaluate(() => window.__urdf.getModel()?.links.size ?? 0);
  check('urdf from .xacro file', n > 0, n);
  check('xacro view no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}
{
  const bad = `${shots}/broken.urdf`;
  (await import('fs')).writeFileSync(bad, '<robot name="x"><link name="a"></robot>');
  const p = await open('urdf', { file: bad });
  await p.waitForSelector('.notice:not(.hidden)', { timeout: 10000 }).catch(() => undefined);
  check('broken URDF shows parse error', /Cannot parse/.test((await p.textContent('.notice').catch(() => '')) ?? ''));
  await p.close();
}

await browser.close();
console.log(`\n${fails.length} failure(s)`);
process.exit(fails.length ? 1 : 0);
