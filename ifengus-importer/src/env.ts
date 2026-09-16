// ---------------------------------------------------------------------------
// Give Node the DOM globals the parsers expect. Side effect only — import it
// FIRST, before anything touching DOMParser/document/Node, and load those
// modules dynamically so their evaluation happens after this ran.
//
// paste.util.ts was written for a browser and is shared verbatim with the
// editor. Rewriting it for Node would mean two implementations of the same
// HTML-to-block logic drifting apart; installing a DOM keeps one.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>');

const g = globalThis as any;
g.window = window;
g.document = window.document;
g.DOMParser = window.DOMParser;
g.Node = window.Node;
g.Element = window.Element;
g.HTMLElement = window.HTMLElement;
g.HTMLImageElement = window.HTMLImageElement;
g.DocumentFragment = window.DocumentFragment;

export const domWindow = window;
