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
const PAGE_HEADER_RE = /^(Страница \d+|Стр\.\s*\d+)$/;
const KNOWN_SECTION_HEADER_RE = /^(Вопрос|Вопросы|Проверьте свои знания|Примените свои знания|Используйте дополнительную информацию|Лабораторный опыт(?: \d+(?:\.\s*.+)?)?|Практическая работа(?: \d+(?:\.\s*.+)?)?|Вопросы в конце параграфа|Вопросы из текста параграфа|Вопросы и задания|Обобщение по теме|Домашний эксперимент|Выразите свое мнение)$/;
const CONTENTS_BULLET_RE = /^[*•-]\s*(.+?)\s*$/;
const MINOR_SECTION_HEADER_RE = /^(Сообщение|Ответ в виде таблицы)$/;

function normalizeHeader(text) {
    return (text || '')
        .toString()
        .replace(/\r\n/g, '\n')
        .trim()
        .replace(/:+$/, '')
        .replace(/\s+/g, ' ');
}

function isPageReference(text) {
    return PAGE_HEADER_RE.test(normalizeHeader(text));
}

function isSectionHeader(text, extraHeaders = new Set()) {
    const normalized = normalizeHeader(text);
    if (!normalized) return false;
    return isPageReference(normalized)
        || KNOWN_SECTION_HEADER_RE.test(normalized)
        || extraHeaders.has(normalized);
}

function extractLeadingContents(text) {
    const normalized = (text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return { headers: new Set(), bodyText: '' };

    const lines = normalized.split('\n');
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index += 1;

    if (index >= lines.length || normalizeHeader(lines[index]) !== 'Содержание') {
        return { headers: new Set(), bodyText: normalized };
    }

    index += 1;
    const headers = new Set();
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (!trimmed) {
            index += 1;
            continue;
        }

        const match = trimmed.match(CONTENTS_BULLET_RE);
        if (!match) break;

        const header = normalizeHeader(match[1]);
        if (!header) break;
        headers.add(header);
        index += 1;
    }

    return {
        headers,
        bodyText: lines.slice(index).join('\n').trim()
    };
}

function parseSolutionBlocks(text, sectionHeaders = new Set()) {
    if (!text || !text.trim()) return [];
    const paragraphs = splitIntoParagraphs(text.trim(), sectionHeaders);
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
        } else if (isSectionHeader(para, sectionHeaders)) {
            blocks.push({ type: 'header', text: normalizeHeader(para) });
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

function splitIntoParagraphs(text, sectionHeaders = new Set()) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    const preservedBlocks = [];
    let protectedText = normalized.replace(/\[\[TABLE\]\][\s\S]*?\[\[\/TABLE\]\]/g, match => {
        const token = `__GDZ_TABLE_${preservedBlocks.length}__`;
        preservedBlocks.push(match.trim());
        return `\n\n${token}\n\n`;
    });
    protectedText = protectedText.replace(/^\|.+\|\n\|(?:\s*:?-{3,}:?\s*\|)+\n(?:\|.*\|\n?)+/gms, match => {
        const token = `__GDZ_TABLE_${preservedBlocks.length}__`;
        preservedBlocks.push(match.trim());
        return `\n\n${token}\n\n`;
    });

    // Split by double newlines first
    const explicitBlocks = protectedText.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
    if (explicitBlocks.length > 1) {
        return restorePreservedBlocks(explicitBlocks.flatMap(block => {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 1 && lines.every(l =>
                l.startsWith('-') || l.startsWith('•') || NUMBER_ITEM_RE.test(l) || l.length <= 140
            )) {
                return lines;
            }
            return [block];
        }), preservedBlocks);
    }

    // Single block — try line-by-line
    const lines = protectedText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
        const hasImages = lines.some(l => MARKDOWN_IMAGE_RE.test(l));
        const structuredCount = lines.filter(l =>
            isSectionHeader(l, sectionHeaders) ||
            MINOR_SECTION_HEADER_RE.test(l) ||
            ANSWER_PREFIX_RE.test(l) ||
            LOWER_LETTER_ITEM_RE.test(l) ||
            NUMBER_ITEM_RE.test(l) ||
            l.startsWith('*') ||
            l.startsWith('-') ||
            l.length <= 180 ||
            MARKDOWN_IMAGE_RE.test(l) ||
            /^__GDZ_TABLE_\d+__$/.test(l)
        ).length;
        if (hasImages || structuredCount >= lines.length / 2) {
            return restorePreservedBlocks(lines, preservedBlocks);
        }
    }

    // Sentence split for long text
    const sentences = protectedText.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length <= 3) return restorePreservedBlocks([protectedText], preservedBlocks);

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
    return restorePreservedBlocks(result.length ? result : [protectedText], preservedBlocks);
}

function restorePreservedBlocks(blocks, preservedBlocks) {
    if (!preservedBlocks.length) return blocks;
    return blocks.map(block => {
        let restored = block;
        preservedBlocks.forEach((preserved, index) => {
            restored = restored.replace(`__GDZ_TABLE_${index}__`, preserved);
        });
        return restored;
    });
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
    const leadingContents = extractLeadingContents(text);
    let content = leadingContents.bodyText;

    // Extract page refs
    const pageRefs = [...new Set((content.match(PAGE_REF_RE) || []))];
    content = content.replace(PAGE_REF_RE, '').trim().replace(/\n{3,}/g, '\n\n');
    const sections = parseSections(content, leadingContents.headers);
    return {
        name,
        headerInfo: pageRefs.join(' • '),
        sections
    };
}

function parseSections(text, sectionHeaders = new Set()) {
    const normalized = (text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [{ title: '', blocks: [] }];

    const sections = [];
    const currentLines = [];
    let currentTitle = '';
    let foundSectionHeader = false;

    function flushCurrent() {
        const body = currentLines.join('\n').trim();
        currentLines.length = 0;
        if (!body) return;
        sections.push({
            title: currentTitle,
            blocks: parseSolutionBlocks(body, sectionHeaders)
        });
    }

    normalized.split('\n').forEach(line => {
        const trimmed = line.trim();
        const sectionHeader = isSectionHeader(trimmed, sectionHeaders) && !isPageReference(trimmed);

        if (sectionHeader) {
            if (!foundSectionHeader) {
                const prefix = currentLines.join('\n').trim();
                if (shouldKeepPrefix(prefix)) {
                    sections.push({
                        title: '',
                        blocks: parseSolutionBlocks(prefix, sectionHeaders)
                    });
                }
                currentLines.length = 0;
                foundSectionHeader = true;
            } else {
                flushCurrent();
            }

            currentTitle = normalizeHeader(trimmed);
            return;
        }

        currentLines.push(line);
    });

    if (!foundSectionHeader) {
        return [{
            title: '',
            blocks: parseSolutionBlocks(normalized, sectionHeaders)
        }];
    }

    flushCurrent();

    return sections.length ? sections : [{
        title: '',
        blocks: parseSolutionBlocks(normalized, sectionHeaders)
    }];
}

function shouldKeepPrefix(prefix) {
    if (!prefix) return false;
    const lines = prefix.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return false;
    if (lines.length <= 2 && prefix.length <= 160) return false;
    if (lines.length === 1 && /^Страница\s+\d+$/.test(lines[0])) return false;
    return true;
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
