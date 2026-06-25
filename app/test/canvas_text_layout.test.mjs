import test from 'node:test';
import assert from 'node:assert/strict';

import {
    drawFittedTextBlock,
    wrapCanvasText,
} from '../src/assets/threejs/canvasTextLayout.js';

function createMockContext() {
    const drawn = [];
    let font = 'bold 10px Arial';

    return {
        drawn,
        get font() {
            return font;
        },
        set font(value) {
            font = value;
        },
        measureText(text) {
            const fontSize = Number.parseFloat(font.match(/(\d+(?:\.\d+)?)px/)?.[1] || '10');
            return { width: Array.from(String(text)).length * fontSize * 0.6 };
        },
        fillText(text, x, y) {
            drawn.push({ text, x, y, font });
        },
    };
}

test('wraps long chemical names without dropping words', () => {
    const context = createMockContext();
    context.font = 'bold 28px Arial';
    const name = 'Kali hexacyanoferrat III khan tinh khiết phân tích';
    const lines = wrapCanvasText(context, name, 208);

    assert.equal(lines.join('').replace(/\s/g, ''), name.replace(/\s/g, ''));
    assert.ok(lines.length > 1);
    assert.ok(lines.every(line => context.measureText(line).width <= 208));
});

test('splits an unbroken long name without dropping characters', () => {
    const context = createMockContext();
    context.font = 'bold 28px Arial';
    const name = 'Tetramethylammoniumhydroxidepentahydrate';
    const lines = wrapCanvasText(context, name, 208);

    assert.equal(lines.join(''), name);
    assert.ok(lines.length > 1);
    assert.ok(lines.every(line => context.measureText(line).width <= 208));
});

test('reduces the font size until every line fits inside the label', () => {
    const context = createMockContext();
    const name = 'Natri hydro cacbonat tinh khiết dùng trong phòng thí nghiệm';

    drawFittedTextBlock(context, name, {
        x: 128,
        y: 116,
        maxWidth: 208,
        maxHeight: 112,
        maxFontSize: 28,
    });

    assert.equal(context.drawn.map(line => line.text).join(' '), name);
    assert.ok(context.drawn.every((line) => {
        context.font = line.font;
        return context.measureText(line.text).width <= 208;
    }));
    assert.ok(context.drawn.every(line => line.y >= 116 && line.y <= 228));
});
