import type { EditAction, EditChange, FileNode } from '../types';

function serialize(doc: Document): string {
  const xml = new XMLSerializer();
  return Array.from(doc.childNodes, node =>
    node === doc.documentElement ? doc.documentElement.outerHTML : xml.serializeToString(node)
  ).join('');
}

// A path is relative to the authored body. It stays valid when an element is
// replaced with a different tag, or a deck script reorders the preview.
export function sourceSelector(element: Element): string {
  const parts = [];
  for (let el = element; el.parentElement && el !== el.ownerDocument.body; el = el.parentElement) {
    parts.unshift(':nth-child(' + (Array.prototype.indexOf.call(el.parentElement.children, el) + 1) + ')');
  }
  return ['body', ...parts].join(' > ');
}

export class DeckDocument {
  readonly source: Document;
  readonly marker = 'data-deckforge-' + crypto.randomUUID();
  preview: Document | null = null;

  constructor(file: FileNode) {
    const html = typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content);
    this.source = new DOMParser().parseFromString(html, 'text/html');
  }

  finishTyping() {
    this.preview?.querySelector<HTMLElement>('[' + this.marker + '-editing]')?.blur();
  }

  serialize(): string { return serialize(this.source); }

  previewHtml(): string {
    const copy = this.source.cloneNode(true) as Document;
    this.markTree(copy.body, 'body');
    return serialize(copy);
  }

  private markTree(el: Element, path: string) {
    el.setAttribute(this.marker, path);
    Array.from(el.children).forEach((child, index) => {
      this.markTree(child, path + ' > :nth-child(' + (index + 1) + ')');
    });
  }

  previewElement(selector: string): HTMLElement | null {
    const matches = this.preview?.querySelectorAll<HTMLElement>('[' + this.marker + '="' + CSS.escape(selector) + '"]');
    return matches?.length === 1 ? matches[0] : null;
  }

  // Retain authored attributes on nested links/spans, including relative URLs.
  // Browser-created markup (line breaks, pasted text, etc.) has no source marker.
  editedContent(el: Element): string {
    const copyNode = (node: Node): Node => {
      if (node.nodeType !== Node.ELEMENT_NODE) return node.cloneNode(false);
      const element = node as Element;
      const path = element.getAttribute(this.marker);
      const original = path && this.source.querySelector(path);
      const copy = (original || element).cloneNode(false) as Element;
      copy.removeAttribute(this.marker);
      copy.append(...Array.from(node.childNodes, copyNode));
      return copy;
    };
    const container = this.source.createElement('div');
    container.append(...Array.from(el.childNodes, copyNode));
    return container.innerHTML;
  }

  styleChanges(target: string, styles: Record<string, string>): EditChange[] {
    const el = this.source.querySelector<HTMLElement>(target);
    if (!el) return [];
    return Object.entries(styles).map(([name, after]) => {
      const property = name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
      return { type: 'style', property, priority: el.style.getPropertyPriority(property),
        before: el.style.getPropertyValue(property), after };
    });
  }

  apply(action: EditAction, direction: 'before' | 'after', alreadyTyped = false): boolean {
    const source = this.source.querySelector<HTMLElement>(action.target);
    const live = this.previewElement(action.target);
    if (!source || !live) return false;
    for (const change of action.changes) {
      const value = change[direction];
      switch (change.type) {
        case 'style':
          for (const el of [source, live]) {
            el.style.setProperty(change.property, value, change.priority);
            if (!el.style.length) el.removeAttribute('style');
          }
          break;
        case 'attribute':
          for (const el of [source, live]) {
            if (value === null) el.removeAttribute(change.name);
            else el.setAttribute(change.name, value);
          }
          break;
        case 'content':
          source.innerHTML = value!;
          if (!alreadyTyped) live.innerHTML = value!;
          this.markTree(live, action.target);
          break;
        case 'element': {
          const range = this.source.createRange();
          range.selectNode(source);
          const next = range.createContextualFragment(value!).firstElementChild;
          if (!next) return false;
          const previewCopy = live.ownerDocument.importNode(next, true);
          this.markTree(previewCopy, action.target);
          source.replaceWith(next);
          live.replaceWith(previewCopy);
          break;
        }
      }
    }
    return true;
  }
}
