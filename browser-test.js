/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 画面まわりの不具合は node のテストでは捕まらない。ここでは本物の
 * ブラウザを立ち上げ、指の操作をそのまま再現して確かめる。
 *
 * ★ アプリを作ったら「ここにアプリごとの確認を足す」に書き足すこと。
 *   直した不具合には、かならず見張り役をここに置く。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 8123);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;   // 手元の Chromium を使いたいとき

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}

function skip(message) {
  console.log('  \x1b[90m- とばした: ' + message + '\x1b[0m');
}

function section(name) {
  console.log('\n' + name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

/**
 * 何かした直後に、その要素が本来の場所からどれだけずれるかを
 * 1 フレームずつ測る。「置いた瞬間に一瞬とぶ」たぐいの不具合はこれで見つかる。
 *
 * @returns {Promise<number>} 最大のずれ (px)
 */
function measureJump(page, selector, act) {
  return page.evaluate(async ({ sel, code }) => {
    const before = document.querySelector(sel).getBoundingClientRect();
    // eslint-disable-next-line no-new-func
    new Function(code)();
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = document.querySelector(sel);
      if (!el) { worst = Infinity; break; }
      const now = el.getBoundingClientRect();
      worst = Math.max(worst, Math.abs(now.left - before.left), Math.abs(now.top - before.top));
    }
    return Math.round(worst);
  }, { sel: selector, code: act });
}

async function run() {
  let chromium;
  let devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], {
    stdio: 'ignore'
  });
  await waitForServer();

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const errors = [];

  try {
    // ------------------------------------------------ スマホで開く
    section('スマホで開く');
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const phone = await context.newPage();
    phone.on('pageerror', (e) => errors.push('スマホ: ' + e.message));
    phone.on('console', (m) => { if (m.type() === 'error') errors.push('スマホ: ' + m.text()); });
    await phone.goto(URL, { waitUntil: 'load' });
    ok(true, 'ページが開く');

    const fit = await phone.evaluate(() => ({
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      title: document.title.trim(),
      painted: document.body.innerText.trim().length + document.querySelectorAll('canvas, svg, img').length
    }));
    ok(fit.wide <= 1, 'スマホ幅で横スクロールが出ない');
    ok(fit.title.length > 0, `ページの名前 (title) がある (${fit.title})`);
    ok(fit.painted > 0, '画面に何か出ている (真っ白ではない)');

    // ホーム画面から開いたとき、時計や電池の帯の下まで描く指定がそろっている
    // (無いと、画面のいちばん上が theme-color の板になる。帯そのものは実機でしか見られない)
    const bar = await phone.evaluate(() => {
      const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content || '';
      return {
        capable: meta('apple-mobile-web-app-capable'),
        style: meta('apple-mobile-web-app-status-bar-style'),
        cover: /viewport-fit=cover/.test(meta('viewport')),
        theme: meta('theme-color')
      };
    });
    ok(bar.capable === 'yes' && bar.style === 'black-translucent' && bar.cover,
      `ホーム画面から開くと帯の下まで描く指定がある (${JSON.stringify(bar)})`);
    ok(/^#[0-9a-f]{6}$/i.test(bar.theme), `帯の色 (theme-color) が決めてある (${bar.theme})`);

    // ------------------------------------------------ ここにアプリごとの確認を足す
    section('アプリの操作 (やりのぼり)');
    {
      const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push('やりのぼり: ' + e.message));
      await pg.goto(URL, { waitUntil: 'load' });
      // 絵 (canvas) は根っこいっぱい。ホーム画面から開いたとき下に帯が出ない作り (CLAUDE.md の落とし穴)
      const size = await pg.evaluate(() => ({ c: document.getElementById('c').getBoundingClientRect().height, s: window.__app.size }));
      ok(Math.round(size.c) === 932 && size.s.H === 932, `絵が画面の高さいっぱい (${Math.round(size.c)}pt / 計算に使う高さ ${size.s.H})`);
      await pg.locator('#startBtn').tap();
      ok(await pg.evaluate(() => window.__app.state === 'play'), '「はじめる」で遊びはじめる');
      // タップするとヤリが飛び、ビルにささる (玉が点線から十分上にいるときに打つ。近いと飛ぶヤリが玉に当たって終わる)
      await pg.waitForFunction(() => { const a = window.__app; return a.ball.y - a.R > a.camY + a.size.H * (1 - a.LAUNCH_FRAC) + 90; });
      await pg.touchscreen.tap(215, 300);
      const fl = await pg.evaluate(() => window.__app.flying.length);
      await pg.waitForTimeout(300);
      const st = await pg.evaluate(() => ({ sp: window.__app.spears.length, fl: window.__app.flying.length, st: window.__app.state }));
      ok(fl === 1 && st.sp === 1 && st.fl === 0 && st.st === 'play', `タップするとヤリが飛び、ビルにささる (飛んでいる ${fl} → ささった ${st.sp})`);
      // うまい打ち方 (ゲームの「いま!」と同じ見きわめ) をページの中で毎コマ判断して打つと、どんどん登れる
      // (外から見張って打つと遅れて打ち損ねた。ヤリが届くまで 0.12 秒かかるので、点線のずっと上で打つ)
      await pg.reload();
      await pg.locator('#startBtn').tap();
      await pg.evaluate(() => {
        const cv = document.getElementById('c'); let last = 0;
        (function loop(t) {
          const a = window.__app; if (a.state !== 'play' || window.__stopBot) return;
          const line = a.camY + a.size.H * (1 - a.LAUNCH_FRAC), bb = a.ball.y - a.R, bf = bb + a.ball.vy * a.FLY - 0.5 * a.G * a.FLY * a.FLY;
          if (a.ball.vy < 0 && bf > line + 6 && bb < line + 220 && t - last > 250) { last = t; cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); }
          requestAnimationFrame(loop);
        })(0);
      });
      await pg.waitForTimeout(8000);
      const climb = await pg.evaluate(() => ({ f: window.__app.floors(), b: window.__app.bounces, st: window.__app.state }));
      ok(climb.st === 'play' && climb.f >= 12 && climb.b >= 4, `うまく打つと 8 秒で ${climb.f} かいまで登れる (ヤリではねた ${climb.b} 回)`);
      // とんでいるヤリが玉に当たると おしまい。のぼったかいだけコインが入り、さいこうを覚える
      await pg.evaluate(() => { window.__stopBot = true; });
      const before = await pg.evaluate(() => ({ coins: window.__app.save.coins, f: window.__app.floors() }));
      await pg.evaluate(() => {   // 玉がちょうど点線の高さに来たときに打って、わざと当てる
        const cv = document.getElementById('c');
        return new Promise((r) => (function loop() {
          const a = window.__app; if (a.state !== 'play') return r();
          const line = a.camY + a.size.H * (1 - a.LAUNCH_FRAC);
          if (Math.abs(a.ball.y - line) < a.R) cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          requestAnimationFrame(loop);
        })());
      });
      await pg.waitForTimeout(700);
      const over = await pg.evaluate(() => ({ st: window.__app.state, shown: !document.getElementById('overOv').classList.contains('hidden'),
        coins: window.__app.save.coins, res: +document.getElementById('resNum').textContent, best: window.__app.best.floors }));
      ok(over.st === 'over' && over.shown, 'とんでいるヤリが玉に当たると おしまいの札が出る');
      ok(over.coins === before.coins + over.res && over.best >= over.res, `のぼったかいだけコインが入り (+${over.res})、さいこうを覚える (${over.best} かい)`);
      await pg.reload();
      ok(await pg.evaluate((b) => window.__app.best.floors === b, over.best), '開き直しても さいこうとコインを覚えている');
      // ガチャ: 10 コインで 1 かい。新しい玉は手もちに入り、つかう玉になる
      await pg.evaluate(() => { window.__app.save.coins = 30; });
      await pg.locator('#gachaBtn1').tap();
      const g0 = await pg.evaluate(() => ({ c: window.__app.save.coins, n: window.__app.save.owned.length }));
      await pg.locator('#pullBtn').tap();
      await pg.waitForTimeout(1500);
      const g1 = await pg.evaluate(() => ({ c: window.__app.save.coins, n: window.__app.save.owned.length, msg: document.getElementById('gMsg').textContent }));
      ok((g1.n === g0.n + 1 && g1.c === g0.c - 10) || (g1.n === g0.n && g1.c === g0.c - 7), `ガチャを ひくと コインが減り、玉が手もちに入る (${g1.msg})`);
      await ctx.close();
    }

    // ------------------------------------------------ 明るい画面・暗い画面
    section('明るい画面と暗い画面');
    for (const scheme of ['light', 'dark']) {
      const themed = await browser.newContext({ ...devices['iPhone 13'], colorScheme: scheme });
      const page = await themed.newPage();
      page.on('pageerror', (e) => errors.push(scheme + ': ' + e.message));
      await page.goto(URL, { waitUntil: 'load' });
      const colors = await page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color
      }));
      ok(colors.bg !== colors.fg, `${scheme}: 文字と背景の色が違う (${colors.bg} / ${colors.fg})`);
      await themed.close();
    }

    // ------------------------------------------------ アイコン (用意していれば)
    section('アイコン');
    const desk = await browser.newPage();
    await desk.goto(URL);
    const apple = await desk.evaluate(() =>
      document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'));
    // 対象は iPhone のホーム画面から開く使い方なので、無ければとばさずに落とす
    // (とばしにしていたら、れんだメーターでアイコンが無いまま公開した。CLAUDE.md の落とし穴)
    ok(!!apple, 'ホーム画面用のアイコン (apple-touch-icon) の指定がある');
    if (apple) {
      // iOS は SVG のアイコンを使えない
      ok(apple.endsWith('.png'), `ホーム画面用アイコンが PNG (${apple})`);
      const res = await desk.request.get(URL + apple.replace('./', ''));
      ok(res.ok(), `${apple} が配信される`);
    }

    // ------------------------------------------------ 更新とオフライン (sw.js があれば)
    section('更新とオフライン');
    if (!fs.existsSync(path.join(ROOT, 'sw.js'))) {
      skip('サービスワーカーはまだ無い (オフライン対応するときに用意する)');
    } else {
      const swCtx = await browser.newContext();
      const swPage = await swCtx.newPage();
      await swPage.goto(URL, { waitUntil: 'load' });
      ok(await swPage.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false)),
        'サービスワーカーが動く');
      await swPage.waitForTimeout(800);

      // 直したものが 1 回のリロードで出るか (キャッシュ優先だと古い画面が出る)
      const indexPath = path.join(ROOT, 'index.html');
      const original = fs.readFileSync(indexPath, 'utf8');
      // 画面を JS で描くアプリもあるので、<h1> ではなく <title> を書き換えて見る
      const marker = original.match(/<title[^>]*>([^<]*)<\/title>/);
      fs.writeFileSync(indexPath, original.replace(marker[0], '<title>こうしんかくにん</title>'));
      await swPage.reload();
      await swPage.waitForTimeout(400);
      const title = await swPage.title();
      fs.writeFileSync(indexPath, original);
      ok(title.trim() === 'こうしんかくにん', `直したものが 1 回のリロードで出る (${title.trim()})`);

      await swPage.reload();
      await swPage.waitForTimeout(500);
      await swCtx.setOffline(true);
      await swPage.reload().catch(() => {});
      await swPage.waitForTimeout(400);
      // 画面が絵だけで字が無いアプリもあるので、字の量ではなくページの名前で見る (はんにんダンスで踏んだ)
      ok(await swPage.evaluate(() => document.title.length > 0 && document.body.children.length > 0).catch(() => false),
        'ネットにつながらなくても開ける');
      await swCtx.setOffline(false);
    }

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
