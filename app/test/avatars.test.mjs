import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarSVG, VARIANTS, EYE_STYLES, BODY_COLORS } from '../renderer/avatars.js';

test('there are at least 10 face variants', () => {
  assert.ok(Object.keys(VARIANTS).length >= 10);
});

test('every variant renders with no background, in any colour and eye style', () => {
  for (const variant of Object.keys(VARIANTS)) {
    for (const { hex } of BODY_COLORS) {
      const svg = avatarSVG({ variant, body: hex, eye: '#FFFFFF', accent: '#22D3EE' }, 40);
      assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
      assert.ok(svg.includes(hex), `${variant} uses its body colour`);
      assert.ok(!/<rect[^>]*width="120"[^>]*height="120"/.test(svg), `${variant} has no background tile`);
    }
    for (const eyeStyle of EYE_STYLES) assert.ok(avatarSVG({ variant, eyeStyle }).includes('</svg>'));
  }
});

test('each render gets its own gradient ids so several faces can share a page', () => {
  const a = avatarSVG({}).match(/id="(kfa\d+)b"/)[1];
  const b = avatarSVG({}).match(/id="(kfa\d+)b"/)[1];
  assert.notEqual(a, b);
});

test('unknown variants fall back instead of breaking', () => {
  assert.ok(avatarSVG({ variant: 'nope' }).includes('</svg>'));
});
