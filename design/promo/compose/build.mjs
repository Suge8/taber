// Promo composites: data-driven HTML canvases → headless Chrome screenshots.
// Run from repo root: node design/promo/compose/build.mjs [name-filter]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const promoDir = path.dirname(here);
const rawDir = path.join(promoDir, 'shots', 'raw');
const brandDir = path.resolve(here, '../../../public/brand');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const INK = '#1b1b1a';
const PAPER = '#fafaf9';
const NIGHT = '#0d0d0c';
const MUTED = 'rgba(27,27,26,0.62)';
const MUTED_DARK = 'rgba(245,245,244,0.64)';

const shot = (theme, name) => `file://${path.join(rawDir, theme, `${name}.png`)}`;
const logo = (variant) => `file://${path.join(brandDir, `taber-logo${variant === 'white' ? '-white' : ''}.png`)}`;

// Halftone dot field echoing the Taber logo language.
function dotField({ width, height, cell = 34, color = INK, opacity = 0.1, focal = [0.9, 0.15], reach = 0.5, maxR = 7.5, minR = 0.8 }) {
  const [fx, fy] = [focal[0] * width, focal[1] * height];
  const maxDist = Math.hypot(width, height) * reach;
  let dots = '';
  for (let y = cell / 2; y < height; y += cell) {
    for (let x = cell / 2; x < width; x += cell) {
      const falloff = Math.max(0, 1 - Math.hypot(x - fx, y - fy) / maxDist);
      const radius = minR + (maxR - minR) * falloff * falloff;
      if (radius < 0.7) continue;
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}"/>`;
    }
  }
  return `<svg class="dots" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><g fill="${color}" fill-opacity="${opacity}">${dots}</g></svg>`;
}

function page({ width, height, body, extraCss = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body { font-family: "SF Pro Display", system-ui, sans-serif; position: relative; -webkit-font-smoothing: antialiased; }
  .dots { position: absolute; inset: 0; z-index: 0; }
  .panel { border-radius: 22px; box-shadow: 0 1px 0 rgba(0,0,0,0.04), 0 24px 80px rgba(0,0,0,0.13), 0 6px 24px rgba(0,0,0,0.07); overflow: hidden; position: relative; z-index: 2; }
  .panel img { display: block; width: 100%; }
  .panel.ring-light { outline: 1px solid rgba(0,0,0,0.09); }
  .panel.ring-dark { outline: 1px solid rgba(255,255,255,0.12); }
  h1 { font-weight: 700; letter-spacing: -0.025em; line-height: 1.06; }
  p.sub { font-weight: 400; letter-spacing: -0.008em; line-height: 1.45; }
  .wordmark { font-weight: 700; letter-spacing: -0.03em; }
  ${extraCss}
  </style></head><body>${body}</body></html>`;
}

// ---- CWS screenshot template: headline left, cropped panel right ----
function cwsShot({ theme, image, title, sub, panelTop = 64, panelWidth = 440 }) {
  const dark = theme === 'dark';
  const [w, h] = [1280, 800];
  return page({
    width: w, height: h,
    body: `
    <div style="position:absolute;inset:0;background:${dark ? NIGHT : PAPER};"></div>
    ${dotField({ width: w, height: h, color: dark ? '#f5f5f4' : INK, opacity: dark ? 0.08 : 0.1, focal: [0.92, 0.1], reach: 0.42 })}
    <div style="position:relative;z-index:2;display:flex;height:100%;align-items:center;">
      <div style="width:600px;padding:0 72px;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:44px;">
          <img src="${logo(dark ? 'white' : 'black')}" width="44" height="44" style="mix-blend-mode:${dark ? 'screen' : 'multiply'};">
          <span class="wordmark" style="font-size:30px;color:${dark ? '#f5f5f4' : INK};">Taber</span>
        </div>
        <h1 style="font-size:58px;color:${dark ? '#f5f5f4' : INK};margin-bottom:22px;">${title}</h1>
        <p class="sub" style="font-size:24px;color:${dark ? MUTED_DARK : MUTED};max-width:430px;">${sub}</p>
      </div>
      <div style="flex:1;position:relative;height:100%;">
        <div class="panel ${dark ? 'ring-dark' : 'ring-light'}" style="position:absolute;top:${panelTop}px;left:60px;width:${panelWidth}px;">
          <img src="${image}">
        </div>
      </div>
    </div>`,
  });
}

// ---- Social/OG template: centered brand block over dot field ----
function socialCard({ w, h, title, sub, pills = [] }) {
  const pillHtml = pills.map((text) => `<span style="display:inline-flex;align-items:center;padding:9px 18px;border-radius:999px;border:1px solid rgba(27,27,26,0.16);font-size:17px;font-weight:500;color:${MUTED};">${text}</span>`).join('');
  return page({
    width: w, height: h,
    body: `
    <div style="position:absolute;inset:0;background:${PAPER};"></div>
    ${dotField({ width: w, height: h, focal: [0.9, 0.16], opacity: 0.11, reach: 0.45 })}
    <div style="position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;height:100%;padding:0 84px;">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:36px;">
        <img src="${logo('black')}" width="56" height="56" style="mix-blend-mode:multiply;">
        <span class="wordmark" style="font-size:40px;color:${INK};">Taber</span>
      </div>
      <h1 style="font-size:64px;color:${INK};max-width:760px;margin-bottom:24px;">${title}</h1>
      <p class="sub" style="font-size:26px;color:${MUTED};max-width:700px;margin-bottom:36px;">${sub}</p>
      <div style="display:flex;gap:12px;">${pillHtml}</div>
    </div>`,
  });
}

const artifacts = {
  'cws-01-autopilot-1280x800': () => cwsShot({
    theme: 'light', image: shot('light', 'task-result'),
    title: 'Hand your browser<br>the task', sub: 'Taber reads pages, compares options, and finishes web tasks in a Chrome side panel.',
  }),
  'cws-02-evidence-1280x800': () => cwsShot({
    theme: 'light', image: shot('light', 'timeline-expanded'),
    title: 'Every step<br>is evidence', sub: 'Clicks, reads, and navigations land in an inspectable timeline — no guessing what it did.',
    panelTop: 40,
  }),
  'cws-03-control-1280x800': () => cwsShot({
    theme: 'dark', image: shot('dark', 'running-expanded'),
    title: 'You stay<br>in control', sub: 'Watch it work live. Stop or take over at any moment.',
    panelTop: 4, panelWidth: 380,
  }),
  'cws-04-skills-1280x800': () => cwsShot({
    theme: 'light', image: shot('light', 'skills'),
    title: 'It knows<br>your sites', sub: 'Built-in skills for shopping, tickets, travel, video, and more — plus what it learns from you.',
    panelTop: 40,
  }),
  'cws-tile-440x280': () => page({
    width: 440, height: 280,
    body: `
    <div style="position:absolute;inset:0;background:${NIGHT};"></div>
    ${dotField({ width: 440, height: 280, color: '#f5f5f4', opacity: 0.1, focal: [0.94, 0.12], cell: 22, maxR: 5, reach: 0.4 })}
    <div style="position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;height:100%;padding:0 40px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
        <img src="${logo('white')}" width="40" height="40" style="mix-blend-mode:screen;">
        <span class="wordmark" style="font-size:32px;color:#f5f5f4;">Taber</span>
      </div>
      <p class="sub" style="font-size:16px;color:${MUTED_DARK};">Browser agent, supervised.</p>
    </div>`,
  }),
  'github-social-1280x640': () => socialCard({
    w: 1280, h: 640,
    title: 'The browser agent<br>you can watch work',
    sub: 'Reads pages, fills forms, finishes web tasks — every step logged, stoppable any time.',
    pills: ['Open source', 'Chrome side panel', 'Bring your own model'],
  }),
  'og-twitter-zh-1200x630': () => socialCard({
    w: 1200, h: 630,
    title: '会动手的浏览器 Agent',
    sub: '读页面、点按钮、填表单、读写文档 —— 每一步都有证据，随时可停。',
    pills: ['开源', 'Chrome 侧边栏', '模型自由'],
  }),
  'og-twitter-1200x630': () => socialCard({
    w: 1200, h: 630,
    title: 'The browser agent<br>you can watch work',
    sub: 'Reads pages, fills forms, finishes web tasks — every step logged, stoppable any time.',
    pills: ['Open source', 'Chrome side panel', 'Bring your own model'],
  }),
  'readme-hero-2400x1260': () => page({
    width: 2400, height: 1260,
    body: `
    <div style="position:absolute;inset:0;background:${PAPER};"></div>
    ${dotField({ width: 2400, height: 1260, cell: 56, maxR: 12, opacity: 0.07, focal: [0.5, 0], reach: 0.55 })}
    <div style="position:relative;z-index:2;text-align:center;padding-top:110px;">
      <h1 style="font-size:96px;color:${INK};margin-bottom:30px;">The browser agent you can watch work</h1>
      <p class="sub" style="font-size:38px;color:${MUTED};">Reads pages, fills forms, finishes web tasks — every step logged, stoppable any time.</p>
    </div>
    <div class="panel ring-light" style="position:absolute;left:490px;top:470px;width:660px;">
      <img src="${shot('light', 'task-result')}">
    </div>
    <div class="panel ring-dark" style="position:absolute;left:1250px;top:470px;width:660px;">
      <img src="${shot('dark', 'running-expanded')}">
    </div>`,
  }),
  'site-card-default-2400x1500': () => page({
    width: 2400, height: 1500,
    body: `
    <div style="position:absolute;inset:0;background:${NIGHT};"></div>
    <div style="position:absolute;inset:0;background:radial-gradient(1400px 1000px at 24% 16%, rgba(245,245,244,0.08), transparent 70%);"></div>
    <svg style="position:absolute;inset:0;opacity:0.05;" width="2400" height="1500"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/></filter><rect width="2400" height="1500" filter="url(#g)"/></svg>
    <img src="${logo('white')}" width="820" height="820" style="position:absolute;right:200px;top:340px;mix-blend-mode:screen;z-index:1;">
    <div style="position:absolute;left:150px;bottom:150px;z-index:2;">
      <div class="wordmark" style="font-size:130px;color:#f5f5f4;margin-bottom:20px;">Taber</div>
      <p class="sub" style="font-size:44px;color:${MUTED_DARK};">Browser agent, supervised.</p>
    </div>`,
  }),
  'site-card-hover-2400x1500': () => page({
    width: 2400, height: 1500,
    body: `
    <div style="position:absolute;inset:0;background:${PAPER};"></div>
    ${dotField({ width: 2400, height: 1500, cell: 52, maxR: 11, opacity: 0.09, focal: [0.94, 0.08], reach: 0.5 })}
    <div class="panel ring-light" style="position:absolute;left:440px;top:75px;width:640px;">
      <img src="${shot('light', 'task-result')}">
    </div>
    <div class="panel ring-dark" style="position:absolute;left:1320px;top:90px;width:640px;">
      <img src="${shot('dark', 'running-expanded')}">
    </div>`,
  }),
};

const filter = process.argv[2];
const tmpDir = path.join(here, '.tmp');
mkdirSync(tmpDir, { recursive: true });
const outputs = { cws: path.join(promoDir, 'shots'), github: path.join(promoDir, 'shots'), og: path.join(promoDir, 'shots'), readme: path.join(promoDir, 'shots'), site: path.join(promoDir, 'visual') };

for (const [name, render] of Object.entries(artifacts)) {
  if (filter && !name.includes(filter)) continue;
  const [width, height] = name.match(/(\d+)x(\d+)$/).slice(1).map(Number);
  const htmlPath = path.join(tmpDir, `${name}.html`);
  writeFileSync(htmlPath, render());
  const outDir = outputs[name.split('-')[0]] ?? path.join(promoDir, 'visual');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${name}.png`);
  execFileSync(chrome, [
    '--headless=new', `--screenshot=${outPath}`, `--window-size=${width},${height}`,
    '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-gpu',
    '--default-background-color=00000000', `file://${htmlPath}`,
  ], { stdio: 'pipe' });
  console.log(`built ${path.relative(promoDir, outPath)}`);
}
rmSync(tmpDir, { recursive: true, force: true });
