export type ConfirmMessageTone = 'standard' | 'warning';

export interface ConfirmMessageItem {
  label: string;
  value: string;
}

export interface ConfirmMessageSection {
  heading: string;
  tone: ConfirmMessageTone;
  items: ConfirmMessageItem[];
}

export interface ParsedConfirmMessage {
  intro: string[];
  sections: ConfirmMessageSection[];
}

function itemFromLine(line: string): ConfirmMessageItem {
  const separator = line.indexOf(': ');
  if (separator < 0) {
    return {
      label: '',
      value: line,
    };
  }

  return {
    label: line.slice(0, separator).trim(),
    value: line.slice(separator + 2).trim(),
  };
}

function sectionTone(heading: string): ConfirmMessageTone {
  return /incongruenc|warning|blocked|danger|full-access/i.test(heading)
    ? 'warning'
    : 'standard';
}

export function parseConfirmMessage(message: string): ParsedConfirmMessage {
  const intro: string[] = [];
  const sections: ConfirmMessageSection[] = [];
  let current: ConfirmMessageSection | null = null;

  const flush = () => {
    if (current && current.items.length > 0) {
      sections.push(current);
    }
    current = null;
  };

  for (const rawLine of message.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.endsWith(':')) {
      flush();
      const heading = line.slice(0, -1).trim();
      current = {
        heading,
        tone: sectionTone(heading),
        items: [],
      };
      continue;
    }

    if (line.startsWith('- ')) {
      if (!current) {
        current = {
          heading: 'Launch details',
          tone: 'standard',
          items: [],
        };
      }
      current.items.push(itemFromLine(line.slice(2).trim()));
      continue;
    }

    flush();
    intro.push(line);
  }

  flush();

  return { intro, sections };
}
