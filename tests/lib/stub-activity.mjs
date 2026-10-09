/* ============================================================
   Intercepts the Worker's POST /event route (ACT-1) so a spec can assert
   what js/activity.js actually sent, without ever reaching the real Worker.
   Covers fetch AND navigator.sendBeacon -- Playwright's page.route hooks the
   browser's network layer, not a JS API, so both arrive here the same way.
   ============================================================ */
const ACTIVITY_HOST = 'laivyhart-audio-upload.ytweiser-399.workers.dev';

/**
 * Wires `page` to swallow every POST /event call, recording each one.
 * Returns the live `calls` array: { body, headers }[], in arrival order.
 */
export async function wireActivityStub(page) {
  const calls = [];
  await page.route(`https://${ACTIVITY_HOST}/event`, async (route) => {
    const req = route.request();
    let body = null;
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* non-JSON: leave null */ }
    calls.push({ body, headers: req.headers() });
    await route.fulfill({ status: 204 });
  });
  return calls;
}
