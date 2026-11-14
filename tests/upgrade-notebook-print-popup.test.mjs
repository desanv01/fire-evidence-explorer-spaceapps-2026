/**
 * U07-r2 regression — printable notebook popup handling.
 *
 * The HTML Standard returns null from window.open(..., "noopener") for a
 * successfully opened tab, so the print opener must use a blank-tab handle,
 * disown the opener before navigating, and fall back to exactly one download.
 * These tests stub only the browser APIs the helper uses; no browser framework.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openPrintableReport, printReportUrlLifetimeMs } from "../src/components/workbench/files.ts";

function installBrowserStubs({ open }) {
  const createdUrls = [];
  const revokedUrls = [];
  const timers = [];
  const clicks = [];
  const anchors = [];
  const openCalls = [];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalSetTimeout = globalThis.setTimeout;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  URL.createObjectURL = () => {
    const url = `blob:print-report-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revokedUrls.push(url);
  };
  globalThis.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  globalThis.window = {
    open(...args) {
      openCalls.push(args);
      return open(...args);
    },
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "a");
      const anchor = {
        href: "",
        download: "",
        rel: "",
        style: {},
        click() {
          clicks.push({ href: anchor.href, download: anchor.download });
        },
        remove() {
          anchor.removed = true;
        },
      };
      anchors.push(anchor);
      return anchor;
    },
    body: {
      append() {
        // The anchor is click-dispatched synchronously; no DOM tree is needed.
      },
    },
  };

  return {
    createdUrls,
    revokedUrls,
    timers,
    clicks,
    anchors,
    openCalls,
    restore() {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      globalThis.setTimeout = originalSetTimeout;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
    },
  };
}

function printableWindow({ navigationError } = {}) {
  const state = { opener: { leaked: true }, openerAtNavigation: "not-navigated", navigatedTo: null, closed: false };
  const fake = {
    get opener() {
      return state.opener;
    },
    set opener(value) {
      state.opener = value;
    },
    closed: false,
    close() {
      state.closed = true;
    },
    location: {
      replace(url) {
        state.openerAtNavigation = state.opener;
        state.navigatedTo = url;
        if (navigationError) throw navigationError;
      },
    },
  };
  return { fake, state };
}

test("successful print open disowns the opener before navigation and never downloads", () => {
  const { fake, state } = printableWindow();
  const stubs = installBrowserStubs({ open: () => fake });
  try {
    const outcome = openPrintableReport("<html>escaped report</html>", "fire-evidence-notebook-nb1.html");

    assert.equal(outcome, "opened");
    assert.deepEqual(stubs.openCalls, [["about:blank", "_blank"]]);
    assert.equal(state.opener, null);
    assert.equal(state.openerAtNavigation, null, "opener is disowned before the report is navigated");
    assert.equal(state.navigatedTo, "blob:print-report-1");
    assert.equal(state.closed, false);
    assert.equal(stubs.clicks.length, 0, "no fallback download on a successful open");
    assert.equal(stubs.anchors.length, 0);
    assert.deepEqual(stubs.revokedUrls, [], "the report URL is not revoked before it loads");
    assert.equal(stubs.timers.length, 1);
    assert.equal(stubs.timers[0].delay, printReportUrlLifetimeMs);

    stubs.timers[0].callback();
    assert.deepEqual(stubs.revokedUrls, ["blob:print-report-1"]);
  } finally {
    stubs.restore();
  }
});

test("blocked popup revokes the unused report URL and triggers exactly one HTML download", () => {
  const stubs = installBrowserStubs({ open: () => null });
  try {
    const outcome = openPrintableReport("<html>escaped report</html>", "print-fallback.html");

    assert.equal(outcome, "downloaded");
    assert.deepEqual(stubs.openCalls, [["about:blank", "_blank"]]);
    assert.deepEqual(stubs.revokedUrls, ["blob:print-report-1"]);
    assert.equal(stubs.clicks.length, 1, "exactly one download");
    assert.equal(stubs.anchors.length, 1);
    assert.equal(stubs.clicks[0].download, "print-fallback.html");
    assert.equal(stubs.clicks[0].href, "blob:print-report-2");
    assert.equal(stubs.anchors[0].removed, true);
    assert.equal(stubs.timers.length, 1);
    assert.equal(stubs.timers[0].delay, 4_000);
  } finally {
    stubs.restore();
  }
});

test("failed navigation closes the blank tab and falls back to one download", () => {
  const { fake, state } = printableWindow({ navigationError: new Error("navigation blocked") });
  const stubs = installBrowserStubs({ open: () => fake });
  try {
    const outcome = openPrintableReport("<html>escaped report</html>", "print-fallback.html");

    assert.equal(outcome, "downloaded");
    assert.equal(state.opener, null);
    assert.equal(state.openerAtNavigation, null);
    assert.equal(state.closed, true, "a failed navigation does not leave a blank tab");
    assert.deepEqual(stubs.revokedUrls, ["blob:print-report-1"]);
    assert.equal(stubs.clicks.length, 1);
    assert.equal(stubs.clicks[0].download, "print-fallback.html");
    assert.equal(stubs.clicks[0].href, "blob:print-report-2");
    assert.equal(stubs.timers.length, 1);
    assert.equal(stubs.timers[0].delay, 4_000);
  } finally {
    stubs.restore();
  }
});
