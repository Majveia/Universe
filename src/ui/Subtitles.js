/**
 * Subtitles — a lower third in the register of Cosmos, not of a video game.
 *
 * The distinction is worth stating because it decides everything else. A game
 * subtitle is a transcript: it exists so you do not miss a mission objective, so
 * it is boxed, high-contrast, and permanent. A documentary subtitle is a
 * *voice*: it is the thing being said, set once, centred, unboxed, and gone. The
 * second one is the register this project wants, so there is no panel, no
 * border, and no background — only a whisper of text shadow so a line survives
 * being spoken over a white sun.
 *
 * Timing is derived, not authored. Nobody should have to hand-time a duration
 * for a generated line, so the display time comes from the length of the text at
 * a comfortable reading speed with a floor for short lines. Long lines are split
 * on sentence boundaries into separate cards rather than shown as a paragraph,
 * because three lines of centred text is a wall and one line is a thought.
 *
 * The queue has exactly one interesting rule: a line marked `priority` clears
 * whatever is waiting behind it. A suit warning that arrives during a long piece
 * of narration must not appear ninety seconds later, when it is no longer true.
 */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/** Characters per second. Deliberately slower than silent reading speed. */
const READ_RATE = 15.5;
/** No line is on screen for less than this, however short. */
const MIN_SECONDS = 1.9;
const MAX_SECONDS = 9.0;
/** Dark beat between cards, so two lines never appear to be one paragraph. */
const GAP = 0.28;
/** Matches the `.subs` opacity transition; the node is only reused after it. */
const FADE = 0.52;

export class Subtitles {
  constructor(root) {
    this.root = el('div', 'subs hud-chrome', root);
    // `polite` and `atomic`: a caption is a whole thought, and a screen reader
    // should say it once, complete, rather than announcing it word by word as
    // the DOM is patched.
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-atomic', 'true');

    this.line = el('div', 'sub-line', this.root);
    this.who = el('span', 'sub-who', this.line);
    this.text = document.createTextNode('');
    this.line.appendChild(this.text);

    this.queue = [];
    this.current = null;
    this._hold = 0;
    this._fade = 0;
    this._shownWho = '';
    this._shownText = '';
    this._on = false;
  }

  /**
   * @param {string} text
   * @param {{who?: string, seconds?: number, priority?: boolean}} [opts]
   *   `who` is a speaker or source, set in small caps above the line.
   *   `priority` cuts the queue and drops everything still waiting.
   */
  say(text, opts = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return;

    if (opts.priority) {
      this.queue.length = 0;
      this._hold = Math.min(this._hold, 0.35);
    }

    for (const part of split(raw)) {
      this.queue.push({
        text: part,
        who: opts.who || '',
        seconds: opts.seconds ?? duration(part),
      });
    }
    // A backlog of narration is worse than a dropped line — by the time the
    // twelfth card appears you are somewhere else entirely.
    while (this.queue.length > 6) this.queue.shift();
  }

  /** Cut immediately: used when the player leaves the scene that was talking. */
  clear() {
    this.queue.length = 0;
    if (this.current) {
      this.current = null;
      this._hold = 0;
      this._fade = FADE;
      this._show(false);
    }
  }

  get isSpeaking() {
    return !!this.current || this.queue.length > 0;
  }

  update(dt) {
    if (this._fade > 0) {
      this._fade -= dt;
      return;                       // the old card is still fading; do not reuse the node
    }

    if (this.current) {
      this._hold -= dt;
      if (this._hold <= 0) {
        this.current = null;
        this._fade = FADE + GAP;
        this._show(false);
      }
      return;
    }

    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this._hold = next.seconds;

    if (this._shownWho !== next.who) {
      this._shownWho = next.who;
      this.who.textContent = next.who;
      this.who.style.display = next.who ? '' : 'none';
    }
    if (this._shownText !== next.text) {
      this._shownText = next.text;
      this.text.nodeValue = next.text;
    }
    this._show(true);
  }

  _show(v) {
    if (v === this._on) return;
    this._on = v;
    this.root.classList.toggle('on', v);
  }

  dispose() {
    this.root.remove();
  }
}

/**
 * Split on sentence ends, but only when the whole thing is long enough to be
 * worth splitting. "Look up." should not become two cards, and a 300-character
 * paragraph should not become one.
 */
function split(s) {
  if (s.length < 110) return [s];
  const parts = s.match(/[^.!?…]+[.!?…]*\s*/g) || [s];
  const out = [];
  let buf = '';
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (buf && buf.length + p.length > 110) { out.push(buf); buf = p; }
    else buf = buf ? `${buf} ${p}` : p;
  }
  if (buf) out.push(buf);
  return out;
}

function duration(s) {
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, 0.9 + s.length / READ_RATE));
}
