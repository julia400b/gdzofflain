/* parser.js — solution text parser, mirrors SolutionContentCodec + SolutionParser */

const MARKDOWN_IMAGE_RE = /^!\[(.*?)\]\((.+?)\)$/;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const ITALIC_RE = /(?<![*])\*([^*]+?)\*(?![*])/g;
const TABLE_BLOCK_RE = /^\[\[TABLE\]\]\n([\s\S]+?)\n\[\[\/TABLE\]\]$/;
const MD_TABLE_RE = /^\|.+\|\n\|(?:\s*:?-{3,}:?\s*\|)+\n(?:\|.*\|\n?)+$/ms;
const ANSWER_PREFIX_RE = /^Ответ:|^Вывод/;
const LOWER_LETTER_ITEM_RE = /^[а-яa-z]\).*/;
const NUMBER_ITEM_RE = /^\d+[.)].*/;
const PAGE_REF_RE = /Стр\.\s*\d+/g;

function parseSolutionBlocks(text) {
    if (!text || !text.trim()) return [];
    const paragraphs = splitIntoParagraphs(text.trim());
    const blocks = [];
    for (const para of paragraphs) {
        const imgMatch = para.match(MARKDOWN_IMAGE_RE);
        const tableMatch = para.match(TABLE_BLOCK_RE);
        const mdTableMatch = para.match(MD_TABLE_RE);
        if (imgMatch) {
            blocks.push({ type: 'image', source: imgMatch[2].trim(), alt: imgMatch[1].trim() || null });
        } else if (tableMatch) {
            blocks.push({ type: 'table', text: tableMatch[1].trim() });
        } else if (mdTableMatch) {
            blocks.push({ type: 'table', text: para.trim() });
        } else if (ANSWER_PREFIX_RE.test(para)) {
            blocks.push({ type: 'emphasis', text: para });
        } else if (para.startsWith('**') && para.endsWith('**')) {
            // Bold line = header
            blocks.push({ type: 'header', text: para.replace(/^\*\*|\*\*$/g, '') });
        } else if ((para.startsWith('*') || para.startsWith('-')) && !para.startsWith('**')) {
            blocks.push({ type: 'bullet_item', text: para.replace(/^[*-]\s*/, '') });
        } else if (LOWER_LETTER_ITEM_RE.test(para) || NUMBER_ITEM_RE.test(para)) {
            blocks.push({ type: 'numbered_item', text: para });
        } else if (para.trim()) {
            blocks.push({ type: 'paragraph', text: para });
        }
    }
    return blocks;
}

function splitIntoParagraphs(text) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    // Split by double newlines first
    const explicitBlocks = normalized.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
    if (explicitBlocks.length > 1) {
        return explicitBlocks.flatMap(block => {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 1 && lines.every(l =>
                l.startsWith('-') || l.startsWith('•') || NUMBER_ITEM_RE.test(l) || l.length <= 140
            )) {
                return lines;
            }
            return [block];
        });
    }

    // Single block — try line-by-line
    const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
        const hasImages = lines.some(l => MARKDOWN_IMAGE_RE.test(l));
        const structuredCount = lines.filter(l =>
            ANSWER_PREFIX_RE.test(l) || LOWER_LETTER_ITEM_RE.test(l) || NUMBER_ITEM_RE.test(l) ||
            l.startsWith('*') || l.startsWith('-') || l.length <= 180 || MARKDOWN_IMAGE_RE.test(l)
        ).length;
        if (hasImages || structuredCount >= lines.length / 2) {
            return lines;
        }
    }

    // Sentence split for long text
    const sentences = normalized.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length <= 3) return [normalized];

    const result = [];
    let current = '';
    for (const sentence of sentences) {
        current += sentence + ' ';
        if (current.length > 150) {
            result.push(current.trim());
            current = '';
        }
    }
    if (current.trim()) result.push(current.trim());
    return result.length ? result : [normalized];
}

function parseSolution(rawText) {
    const text = (rawText || '').trim();
    if (!text) return { editions: [{ name: 'Решение', headerInfo: '', sections: [{ title: '', blocks: [] }] }] };

    // Check for edition markers
    const editionRe = /^Издание\s+(\d+)/m;
    const hasEditions = editionRe.test(text);

    if (!hasEditions) {
        return { editions: [parseEdition('Решение', text)] };
    }

    const parts = text.split(/(?=Издание\s+\d+)/).filter(Boolean);
    const editions = parts.map(part => {
        const match = part.match(/^Издание\s+(\d+)/);
        if (!match) return null;
        const name = `Издание ${match[1]}`;
        const content = part.substring(match[0].length).trim();
        return parseEdition(name, content);
    }).filter(Boolean);

    return { editions: editions.length ? editions : [parseEdition('Решение', text)] };
}

function parseEdition(name, text) {
    let content = text;

    // Extract page refs
    const pageRefs = [...new Set((content.match(PAGE_REF_RE) || []))];
    content = content.replace(PAGE_REF_RE, '').trim().replace(/\n{3,}/g, '\n\n');

    const blocks = parseSolutionBlocks(content);
    return {
        name,
        headerInfo: pageRefs.join(' • '),
        sections: [{ title: '', blocks }]
    };
}

function resolveImageUrl(source) {
    const trimmed = (source || '').trim();
    if (trimmed.startsWith('asset://')) {
        return trimmed.replace('asset://', '');
    }
    if (trimmed.startsWith('/')) {
        return 'https://www.euroki.org' + trimmed;
    }
    return trimmed;
}

function renderInlineMarkdown(text) {
    // Escape HTML first
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    // Then apply markdown formatting
    return escaped
        .replace(BOLD_RE, '<strong>$1</strong>')
        .replace(ITALIC_RE, '<em>$1</em>');
}
