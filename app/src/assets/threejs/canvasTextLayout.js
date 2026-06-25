export function wrapCanvasText(context, text, maxWidth) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const lines = [];
    let currentLine = '';

    const pushLongWord = (word) => {
        let part = '';
        Array.from(word).forEach((character) => {
            const candidate = part + character;
            if (part && context.measureText(candidate).width > maxWidth) {
                lines.push(part);
                part = character;
            } else {
                part = candidate;
            }
        });
        return part;
    };

    words.forEach((word) => {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (context.measureText(candidate).width <= maxWidth) {
            currentLine = candidate;
            return;
        }

        if (currentLine) {
            lines.push(currentLine);
            currentLine = '';
        }

        currentLine = context.measureText(word).width > maxWidth
            ? pushLongWord(word)
            : word;
    });

    if (currentLine) lines.push(currentLine);
    return lines;
}

export function drawFittedTextBlock(context, text, options) {
    const {
        x,
        y,
        maxWidth,
        maxHeight,
        maxFontSize,
        minFontSize = 4,
        fontFamily = 'Arial',
        fontWeight = 'bold',
        lineHeightRatio = 1.12,
    } = options;

    let fontSize = maxFontSize;
    let lines = [];
    let lineHeight = fontSize * lineHeightRatio;

    while (fontSize >= minFontSize) {
        context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        lines = wrapCanvasText(context, text, maxWidth);
        lineHeight = fontSize * lineHeightRatio;
        if (lines.length * lineHeight <= maxHeight) break;
        fontSize -= 1;
    }

    context.font = `${fontWeight} ${Math.max(fontSize, minFontSize)}px ${fontFamily}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    const blockHeight = lines.length * lineHeight;
    const firstLineY = y + ((maxHeight - blockHeight) / 2) + (lineHeight / 2);
    lines.forEach((line, index) => {
        context.fillText(line, x, firstLineY + (index * lineHeight));
    });
}
