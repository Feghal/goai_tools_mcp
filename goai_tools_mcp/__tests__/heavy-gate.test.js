'use strict';

// The concurrency gate: utils/semaphore.js (the mechanism), utils/heavyGate.js
// (the policy) and the registerTool wrapper in controllers/mcpController.js
// that applies it.
//
// What this is defending. Every per-tool memory bound in this service is sized
// against the 400 MB container ASSUMING ONE CALL AT A TIME. Measured on the
// real image at `--memory 400m`, two concurrent image_compress calls and two
// concurrent render_app_store_screenshot calls each end in `exit 137,
// OOMKilled` — with every input entirely inside the bounds its tool
// advertises. On a public unauthenticated endpoint with restart:
// unless-stopped that is a restart loop, not one failed call.

const { createSemaphore, SemaphoreBusyError } = require('../utils/semaphore');
const heavyGate = require('../utils/heavyGate');
const { gateHeavyTools } = require('../controllers/mcpController');

// A job that blocks until the test releases it, so "two at once" is a state
// the test controls rather than a race it hopes for.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('utils/semaphore', () => {
  test('runs one at a time and never overlaps', async () => {
    const sem = createSemaphore({ name: 't', max: 1, maxWaitMs: Infinity });
    let live = 0;
    let peak = 0;
    const job = async () => {
      live++;
      peak = Math.max(peak, live);
      await wait(5);
      live--;
    };
    await Promise.all([sem.run(job), sem.run(job), sem.run(job)]);
    expect(peak).toBe(1);
    expect(sem.stats().active).toBe(0);
  });

  test('releases the slot when the job throws, not only when it resolves', async () => {
    const sem = createSemaphore({ name: 't', max: 1, maxWaitMs: Infinity });
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sem.stats().active).toBe(0);
    // The next job still gets in, which it would not if the slot had leaked.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  test('with waiting disabled a second caller is refused, and its job never runs', async () => {
    const sem = createSemaphore({ name: 't', max: 1, maxWaitMs: 0 });
    const held = deferred();
    const first = sem.run(() => held.promise);
    await wait(1);

    let ran = false;
    const err = await sem.run(async () => { ran = true; }).catch((e) => e);
    expect(err).toBeInstanceOf(SemaphoreBusyError);
    expect(err.semaphore).toBe('t');
    // The distinction the caller depends on: refused means NOT ATTEMPTED, so
    // nothing was allocated on its behalf.
    expect(ran).toBe(false);

    held.resolve('done');
    await expect(first).resolves.toBe('done');
  });

  test('a bounded wait admits a caller once the slot frees', async () => {
    const sem = createSemaphore({ name: 't', max: 1, maxQueued: 4, maxWaitMs: 500 });
    const held = deferred();
    const first = sem.run(() => held.promise);
    await wait(1);
    const second = sem.run(async () => 'second');
    setTimeout(() => held.resolve('first'), 20);
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  test('a bounded wait that expires refuses rather than running late', async () => {
    const sem = createSemaphore({ name: 't', max: 1, maxQueued: 4, maxWaitMs: 20 });
    const held = deferred();
    const first = sem.run(() => held.promise);
    await wait(1);
    let ran = false;
    const err = await sem.run(async () => { ran = true; }).catch((e) => e);
    expect(err).toBeInstanceOf(SemaphoreBusyError);
    expect(err.waitedMs).toBeGreaterThanOrEqual(15);
    expect(ran).toBe(false);
    held.resolve(null);
    await first;
    // The timed-out job is skipped, not run, when the slot finally frees.
    await wait(10);
    expect(ran).toBe(false);
  });

  test('the queue depth is a bound, not a suggestion', async () => {
    const sem = createSemaphore({ name: 't', max: 1, maxQueued: 1, maxWaitMs: 1000 });
    const held = deferred();
    const first = sem.run(() => held.promise);
    await wait(1);
    const queued = sem.run(async () => 'queued');
    await wait(1);
    await expect(sem.run(async () => 'overflow')).rejects.toBeInstanceOf(SemaphoreBusyError);
    held.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(queued).resolves.toBe('queued');
  });

  test('a free slot is admitted even with no queue at all', async () => {
    // maxQueued only governs callers that would have to WAIT. Checking it
    // before checking for a free slot would refuse work the semaphore is
    // idle enough to do.
    const sem = createSemaphore({ name: 't', max: 1, maxQueued: 0, maxWaitMs: 0 });
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
    await expect(sem.run(async () => 'ok again')).resolves.toBe('ok again');
  });

  test('max is re-read per admission, so an operator can retune without a restart', async () => {
    let cap = 1;
    const sem = createSemaphore({ name: 't', max: () => cap, maxWaitMs: 0 });
    const held = deferred();
    const first = sem.run(() => held.promise);
    await wait(1);
    await expect(sem.run(async () => 'x')).rejects.toBeInstanceOf(SemaphoreBusyError);
    cap = 2;
    await expect(sem.run(async () => 'x')).resolves.toBe('x');
    held.resolve(null);
    await first;
  });
});

describe('utils/heavyGate', () => {
  test('gates exactly the tools measured to need it', () => {
    // Measured peak container anon memory for one worst-legal-input call,
    // against a ~40 MB idle container capped at 400 MB.
    for (const name of [
      'render_app_store_screenshot', // 219 MB — 2 concurrent = exit 137
      'image_compress',              // 147 MB — 2 concurrent = exit 137
      'convert_video_to_gif',        // 143 MB
      'resize_images',               // 112 MB
      'convert_heic_to_jpg_png',     // gated on its libheif RGBA decode path
    ]) {
      expect(heavyGate.isHeavyTool(name)).toBe(true);
    }
    // image_compression_curve peaks at 76 MB and survived 4 concurrent calls;
    // the calculators allocate nothing. Gating them would serialise cheap
    // work for no memory benefit.
    for (const name of ['image_compression_curve', 'check_contrast', 'estimate_ai_tokens', 'oklch_ramp']) {
      expect(heavyGate.isHeavyTool(name)).toBe(false);
    }
    expect(heavyGate.isHeavyTool(undefined)).toBe(false);
  });

  test('the busy message tells an agent to retry rather than to shrink the request', () => {
    const msg = heavyGate.busyMessage('convert_video_to_gif');
    expect(msg).toMatch(/convert_video_to_gif/);
    expect(msg).toMatch(/retry/i);
    expect(msg).toMatch(/Nothing is wrong with this request/);
  });
});

describe('controllers/mcpController — gateHeavyTools()', () => {
  // A stand-in for McpServer: only registerTool matters, and shadowing it is
  // exactly what the real wrapper does.
  function fakeServer() {
    const handlers = {};
    const server = {
      registerTool(name, config, handler) { handlers[name] = handler; },
    };
    gateHeavyTools(server);
    return { server, handlers };
  }

  test('a second concurrent heavy call is refused as a tool error, not a crash', async () => {
    const { server, handlers } = fakeServer();
    const held = deferred();
    let calls = 0;
    server.registerTool('render_app_store_screenshot', {}, async () => {
      calls++;
      await held.promise;
      return { content: [{ type: 'text', text: 'rendered' }] };
    });

    const first = handlers.render_app_store_screenshot({});
    await wait(1);
    const second = await handlers.render_app_store_screenshot({});

    // isError:true is what an MCP client reads as "the tool ran and reported a
    // problem" — and what server.js's access log scans for to record
    // outcome=error. A thrown SemaphoreBusyError would have been neither.
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/render_app_store_screenshot is temporarily unavailable/);
    expect(second.content[0].text).toMatch(/retry it in about 30 seconds/);
    // The refused call never entered the handler, so it allocated nothing.
    expect(calls).toBe(1);

    held.resolve();
    await expect(first).resolves.toMatchObject({ content: [{ text: 'rendered' }] });
  });

  test('the slot is released after a heavy call fails, so the next one still gets in', async () => {
    const { server, handlers } = fakeServer();
    server.registerTool('image_compress', {}, async (args) => {
      if (args.explode) throw new Error('bad image');
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    // The tool's own failure must surface as itself, not as a busy message.
    await expect(handlers.image_compress({ explode: true })).rejects.toThrow('bad image');
    await expect(handlers.image_compress({})).resolves.toMatchObject({ content: [{ text: 'ok' }] });
  });

  test('one heavy tool in flight blocks every other heavy tool, not just its own', async () => {
    // The bound is container memory, which is shared: two DIFFERENT heavy
    // tools at once is the same OOM as two of the same one.
    const { server, handlers } = fakeServer();
    const held = deferred();
    server.registerTool('convert_video_to_gif', {}, async () => { await held.promise; return { content: [] }; });
    server.registerTool('resize_images', {}, async () => ({ content: [{ type: 'text', text: 'resized' }] }));

    const first = handlers.convert_video_to_gif({});
    await wait(1);
    const blocked = await handlers.resize_images({});
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/resize_images is temporarily unavailable/);

    held.resolve();
    await first;
  });

  test('a light tool is not gated and answers while a heavy call is in flight', async () => {
    const { server, handlers } = fakeServer();
    const held = deferred();
    server.registerTool('convert_video_to_gif', {}, async () => { await held.promise; return { content: [] }; });
    server.registerTool('check_contrast', {}, async () => ({ content: [{ type: 'text', text: 'ratio' }] }));

    const first = handlers.convert_video_to_gif({});
    await wait(1);
    // Three calculator calls, all served, while the heavy one holds the slot.
    for (let i = 0; i < 3; i++) {
      await expect(handlers.check_contrast({})).resolves.toMatchObject({ content: [{ text: 'ratio' }] });
    }
    held.resolve();
    await first;
  });

  test('heavy calls made one after another all succeed — the gate serialises, it does not ration', async () => {
    const { server, handlers } = fakeServer();
    server.registerTool('image_compress', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    for (let i = 0; i < 5; i++) {
      const r = await handlers.image_compress({});
      expect(r.isError).toBeUndefined();
    }
  });

  test('MCP_HEAVY_QUEUE_WAIT_MS turns the refusal into a bounded wait', async () => {
    const original = process.env.MCP_HEAVY_QUEUE_WAIT_MS;
    process.env.MCP_HEAVY_QUEUE_WAIT_MS = '500';
    try {
      const { server, handlers } = fakeServer();
      const held = deferred();
      server.registerTool('image_compress', {}, async (args) => {
        if (args.hold) await held.promise;
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      const first = handlers.image_compress({ hold: true });
      await wait(1);
      const second = handlers.image_compress({});
      setTimeout(() => held.resolve(), 20);
      await expect(first).resolves.toMatchObject({ content: [{ text: 'ok' }] });
      // Waited rather than being refused, because the operator asked for it.
      await expect(second).resolves.toMatchObject({ content: [{ text: 'ok' }] });
    } finally {
      if (original === undefined) delete process.env.MCP_HEAVY_QUEUE_WAIT_MS;
      else process.env.MCP_HEAVY_QUEUE_WAIT_MS = original;
    }
  });
});
