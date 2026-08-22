import "@testing-library/jest-dom";

// jsdom has no built-in fetch — every component test supplies its own
// mock per-call via `mockFetch(...)` below, but the global must exist as
// an assignable jest.fn() first for jest.spyOn-style usage to work at all.
global.fetch = jest.fn();

// jsdom doesn't implement <dialog>'s modal methods (ConfirmDialog uses the
// native element) — a minimal behavioral polyfill so `open` reflects
// showModal()/close() the way a real browser would.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}
