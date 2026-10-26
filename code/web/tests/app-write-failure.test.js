import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { OfflineWriteError } from '../src/js/offline.js';

/**
 * A store write a view fires and forgets — a drag, a resize, a check-off, an
 * Undo — updates memory and re-renders BEFORE it awaits the network. When the
 * network then refuses, the change is on screen but gone on the next load, so
 * the app has to say so (the editor always did). An offline rejection stays
 * quiet: the write-gate shows its own notice.
 */

function makeStore({ events = [], tasks = [], fail = null } = {}) {
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  const reject = () => (fail ? Promise.reject(fail) : Promise.resolve());
  return {
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    getAllEvents: () => events,
    getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
    getAllTasks: () => tasks,
    getTasksInRange: (from, to) => tasks.filter((t) => t.due >= from && t.due < to),
    getTask: (id) => tasks.find((t) => t.id === id) || null,
    getEvent: (id) => events.find((e) => e.id === id) || null,
    saveSettings: async (patch) => (Object.assign(settings, patch), { ...settings }),
    saveEvent: () => reject(),
    deleteEvent: () => reject(),
    saveTask: () => reject(),
    deleteTask: () => reject(),
    toggleTask: () => reject(),
  };
}

const dayAt = (hour) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 15, hour, 0).getTime();
};

const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('app — a view write that never lands', () => {
  let app;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    vi.restoreAllMocks();
    delete document.documentElement.dataset.theme;
    // Never wipe <body>: toast.js keeps a reference to the container it
    // appended once, so removing it would leave every later toast detached.
    document.querySelectorAll('.toast, .ctx-menu, .app-root, .modal-scrim').forEach((n) => n.remove());
  });

  function mount(store, invites) {
    const root = document.createElement('div');
    root.className = 'app-root';
    document.body.append(root);
    app = createApp(root, { store, invites, user: { username: 'x' } });
    return root;
  }

  /** Fire the context menu on the first chip and click one of its items. */
  function chipMenu(label) {
    const chip = document.querySelector('.chip');
    chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const item = [...document.querySelectorAll('.ctx-menu__item')].find(
      (b) => b.textContent.trim() === label,
    );
    expect(item, `no "${label}" item`).toBeTruthy();
    item.click();
  }

  const event = () => ({
    id: 'e1',
    title: 'Standup',
    start: dayAt(9),
    end: dayAt(10),
    allDay: false,
    color: 'blue',
    reminders: [],
  });

  it('reports a failed duplicate instead of staying silent', async () => {
    mount(makeStore({ events: [event()], fail: new Error('kv down') }));
    chipMenu('复制');
    await flush();
    expect(toasts()).toEqual(['复制事件失败。']);
  });

  it('reports a failed delete', async () => {
    mount(makeStore({ events: [event()], fail: new Error('kv down') }));
    chipMenu('删除');
    await flush();
    expect(toasts()).toEqual(['删除事件失败。']);
  });

  it('reports a failed task check-off', async () => {
    const task = { id: 't1', title: 'Ship it', due: dayAt(9), allDay: false, done: false, color: 'teal', isTask: true };
    mount(makeStore({ tasks: [task], fail: new Error('kv down') }));
    document.querySelector('.chip__check').click();
    await flush();
    expect(toasts()).toEqual(['更新任务失败。']);
  });

  it('stays quiet when the write was refused for being offline', async () => {
    mount(makeStore({ events: [event()], fail: new OfflineWriteError() }));
    chipMenu('复制');
    await flush();
    // offline.js already showed its own notice; a second one would be noise.
    expect(toasts()).toEqual([]);
  });

  it('still reports success when the write lands', async () => {
    mount(makeStore({ events: [event()] }));
    chipMenu('复制');
    await flush();
    expect(toasts()).toEqual(['事件已复制']);
  });
});

