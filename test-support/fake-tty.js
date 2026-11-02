// A fake interactive terminal for TUI tests: keys go in as data events, and the last full frame drawn
// (after the cursor goes home and erases) can be read or awaited as plain text.
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';

export function createFakeTty({ columns = 100 } = {}) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.rawMode = false;
  input.resumed = false;
  input.setRawMode = mode => { input.rawMode = Boolean(mode); };
  input.resume = () => { input.resumed = true; };
  input.pause = () => { input.resumed = false; };

  let buffer = '';
  let frame = '';
  const waiters = [];
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = columns;
  output.write = chunk => {
    buffer += String(chunk);
    // A frame starts after the cursor goes home and the screen is erased, or after leaving the alternate screen.
    const parts = String(chunk).split(/\x1b\[H\x1b\[J|\x1b\[\?1049l/u);
    frame = parts.length > 1 ? stripVTControlCharacters(parts.at(-1)) : frame + stripVTControlCharacters(String(chunk));
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].regex.test(frame)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve();
      }
    }
    return true;
  };
  return {
    input,
    output,
    getOutput: () => buffer,
    getFrame: () => frame,
    sendKey: seq => input.emit('data', Buffer.from(seq, 'utf8')),
    waitFor: regex => (regex.test(frame)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${regex}`)), 4000);
          waiters.push({ regex, resolve: () => { clearTimeout(timer); resolve(); } });
        }))
  };
}
