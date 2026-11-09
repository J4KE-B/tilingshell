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
