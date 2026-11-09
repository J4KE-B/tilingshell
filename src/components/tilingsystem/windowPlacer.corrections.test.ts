/** Retries and corrections of WindowPlacer, driven by a manual clock. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PlacementTarget,
    PlacerClock,
    Rect,
    WindowPlacer,
} from './windowPlacer.ts';

/** A clock whose timers only fire when the test advances time. */
function manualClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; cb: () => void }>();
    const clock: PlacerClock = {
        timeout: (ms, cb) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, cb });
            return id;
        },
        cancel: (handle) => {
            timers.delete(handle as number);
        },
    };
    const advance = (ms: number) => {
        const until = now + ms;
        for (;;) {
            const due = [...timers.entries()]
                .filter(([, t]) => t.at <= until)
                .sort(([, a], [, b]) => a.at - b.at)[0];
            if (!due) break;
            timers.delete(due[0]);
            now = due[1].at;
            due[1].cb();
        }
        now = until;
    };
    return { clock, advance };
}

/**
 * A client that answers every request with `answer(request)` and lets the
 * test change its frame on its own.
 */
function fakeClient(frame: Rect, answer: (r: Rect) => Rect = (r) => r) {
    let current = { ...frame };
    const requests: string[] = [];
    const listeners = new Set<() => void>();
    const setFrame = (r: Rect) => {
        current = { ...r };
        [...listeners].forEach((cb) => cb());
    };
    const target: PlacementTarget = {
        isAlive: () => true,
        getFrameRect: () => ({ ...current }),
        getBufferRect: () => ({ ...current }),
        moveToMonitor: () => {},
        moveFrame: () => {},
        moveResizeFrame: (_u, r) => {
            requests.push(`${r.x},${r.y},${r.width},${r.height}`);
            setFrame(answer(r));
        },
        getActor: () => null,
        onGeometryChanged: (cb) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        onGone: () => () => {},
    };
    return { target, requests, setFrame };
}

const DEST: Rect = { x: 8, y: 48, width: 1520, height: 808 };
const START: Rect = { x: 0, y: 40, width: 800, height: 600 };

test('right size but shifted after settling -> one move back, no loop', () => {
    const { clock, advance } = manualClock();
    // a CSD client whose geometry lands 8px up/left of what was asked
    const shifted = (r: Rect) => ({ ...r, x: r.x - 8, y: r.y - 8 });
    const { target, requests } = fakeClient(START, shifted);
    const placer = new WindowPlacer(clock, { retryDelaysMs: [] });

    placer.place(target, DEST);
    advance(1000);
    // the original request, then exactly one position fix-up, which the
    // client shifts again; it is not asked a third time
    assert.deepEqual(requests, ['8,48,1520,808', '8,48,1520,808']);
    advance(20_000);
    assert.equal(requests.length, 2);
    placer.destroy();
});

test('right size but shifted, client accepts the fix-up -> lands on dest', () => {
    const { clock, advance } = manualClock();
    let first = true;
    const { target } = fakeClient(START, (r) => {
        if (!first) return r;
        first = false;
        return { ...r, x: r.x - 8, y: r.y - 8 };
    });
    const placer = new WindowPlacer(clock, { retryDelaysMs: [] });

    placer.place(target, DEST);
    advance(1000);
    assert.deepEqual(target.getFrameRect(), DEST);
    placer.destroy();
});

test('drift watch puts back a client that moves itself off its tile', () => {
    const { clock, advance } = manualClock();
    const { target, requests, setFrame } = fakeClient(START);
    const placer = new WindowPlacer(clock, { retryDelaysMs: [] });

    placer.place(target, DEST);
    advance(500);
    setFrame({ ...DEST, x: 0, y: 40 }); // e.g. late CSD geometry
    advance(500);
    assert.deepEqual(target.getFrameRect(), DEST);
    // re-asking for the rect mutter last sent goes out behind a 1px nudge
    assert.deepEqual(requests, [
        '8,48,1520,808',
        '8,48,1521,808',
        '8,48,1520,808',
    ]);
    placer.destroy();
});

test('canCorrect false -> a user resize is not reverted', () => {
    const { clock, advance } = manualClock();
    const { target, requests, setFrame } = fakeClient(START);
    const placer = new WindowPlacer(clock, { retryDelaysMs: [] });
    let userGrab = false;

    placer.place(target, DEST, { canCorrect: () => !userGrab });
    advance(500);
    userGrab = true;
    const resized = { ...DEST, width: 1000 };
    setFrame(resized);
    advance(500);
    userGrab = false;
    advance(20_000);
    assert.deepEqual(target.getFrameRect(), resized);
    assert.equal(requests.length, 1);
    placer.destroy();
});

test('canCorrect false -> retries of a refused size are dropped', () => {
    const { clock, advance } = manualClock();
    // refuses to go below 1600px wide
    const { target, requests } = fakeClient(START, (r) => ({
        ...r,
        width: Math.max(r.width, 1600),
    }));
    const placer = new WindowPlacer(clock, { retryDelaysMs: [200, 400] });

    placer.place(target, DEST, { canCorrect: () => false });
    advance(5000);
    assert.equal(requests.length, 1);
    placer.destroy();
});

test('a window placed by another placer is no longer watched by the first', () => {
    const { clock, advance } = manualClock();
    const { target, requests, setFrame } = fakeClient(START);
    const monitorA = new WindowPlacer(clock, {
        monitorIndex: 0,
        retryDelaysMs: [],
    });
    const monitorB = new WindowPlacer(clock, {
        monitorIndex: 1,
        retryDelaysMs: [],
    });

    monitorA.place(target, DEST);
    advance(500);
    const onB: Rect = { x: 1544, y: 48, width: 760, height: 808 };
    monitorB.place(target, onB);
    advance(500);
    // the client drifts on B: B corrects it, A must not drag it back to DEST
    setFrame({ ...onB, width: 700 });
    advance(20_000);
    assert.deepEqual(target.getFrameRect(), onB);
    assert.ok(!requests.slice(1).includes('8,48,1520,808'));
    monitorA.destroy();
    monitorB.destroy();
});
