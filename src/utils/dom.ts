/**
 * DOM 操作工具函数
 */

import type { SelectedElementInfo } from '../types';
import type { DeckDocument } from './deckDocument';

/**
 * 获取元素的计算样式映射
 */
export function getComputedStyleMap(el: HTMLElement): Record<string, string> {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el);
  return {
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    lineHeight: computed.lineHeight,
    letterSpacing: computed.letterSpacing,
    color: computed.color,
    textAlign: computed.textAlign,
    backgroundColor: computed.backgroundColor,
    borderRadius: computed.borderRadius,
    width: computed.width,
    height: computed.height,
    display: computed.display,
    position: computed.position,
    zIndex: computed.zIndex,
    padding: computed.padding,
    margin: computed.margin,
    opacity: computed.opacity,
    boxShadow: computed.boxShadow,
    textDecoration: computed.textDecoration,
    fontStyle: computed.fontStyle,
  };
}

/**
 * 判断元素是否为文本可编辑
 */
export function isTextEditable(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  const editableTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'a', 'li', 'td', 'th', 'label', 'strong', 'em', 'b', 'i', 'small'];
  return editableTags.includes(tag) && !el.querySelector('img, svg, canvas, video, iframe');
}

/**
 * 判断元素是否为图片
 */
export function isImageElement(el: HTMLElement): boolean {
  return el.tagName.toLowerCase() === 'img' || el.tagName.toLowerCase() === 'svg';
}

/**
 * 为 iframe 注入编辑桥接脚本
 */
export function injectEditorBridge(iframe: HTMLIFrameElement, deck: DeckDocument): void {
  if (!iframe.contentWindow || !iframe.contentDocument) return;

  const script = iframe.contentDocument.createElement('script');
  script.textContent = `
    (function() {
      if (window.__deckforgeBridgeLoaded) return;
      window.__deckforgeBridgeLoaded = true;

      const marker = ${JSON.stringify(deck.marker)};
      let allSlides = [];
      const originalDisplayStyles = new WeakMap();

      function getOriginalDisplay(el) {
        if (!originalDisplayStyles.has(el)) {
          const display = readEffectiveDisplay(el);
          originalDisplayStyles.set(el, display);
        }
        return originalDisplayStyles.get(el);
      }

      function readEffectiveDisplay(el) {
        // 先尝试读取当前计算样式（若元素已可见）
        const cs = window.getComputedStyle(el);
        if (cs.display && cs.display !== 'none') return cs.display;

        // 元素当前不可见，临时解禁并读取真实 display，避免把 none 当作原始值
        const prevDisplay = el.style.display;
        const prevVisibility = el.style.visibility;
        const prevOpacity = el.style.opacity;
        const prevPosition = el.style.position;
        el.style.display = '';
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        el.style.position = 'absolute';
        const effective = window.getComputedStyle(el).display || 'block';
        el.style.display = prevDisplay;
        el.style.visibility = prevVisibility;
        el.style.opacity = prevOpacity;
        el.style.position = prevPosition;
        return effective;
      }

      function inferDisplayType(el) {
        // 优先从匹配的 CSS 规则读取 display
        const fromCss = readDisplayFromCssRules(el);
        if (fromCss) return fromCss;

        // 根据标签推断一个合理的 display 值
        const tag = el.tagName.toLowerCase();
        if (tag === 'li') return 'list-item';
        if (tag === 'table') return 'table';
        if (tag === 'tr') return 'table-row';
        if (tag === 'td' || tag === 'th') return 'table-cell';
        if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') return 'table-row-group';
        if (tag === 'colgroup') return 'table-column-group';
        if (tag === 'col') return 'table-column';
        if (tag === 'form' || tag === 'fieldset' || tag === 'figcaption' || tag === 'figure' || tag === 'footer' || tag === 'header' || tag === 'main' || tag === 'nav' || tag === 'section' || tag === 'article' || tag === 'aside' || tag === 'details' || tag === 'summary' || tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6' || tag === 'blockquote' || tag === 'pre' || tag === 'address') return 'block';
        if (tag === 'span' || tag === 'a' || tag === 'em' || tag === 'strong' || tag === 'b' || tag === 'i' || tag === 'small' || tag === 'sub' || tag === 'sup' || tag === 'label' || tag === 'abbr' || tag === 'cite' || tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'var') return 'inline';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video' || tag === 'audio' || tag === 'iframe') return 'inline-block';
        return 'block';
      }

      function readDisplayFromCssRules(el) {
        try {
          const sheets = Array.from(document.styleSheets);
          for (const sheet of sheets) {
            const rules = sheet.cssRules || sheet.rules;
            if (!rules) continue;
            for (const rule of rules) {
              if (rule.selectorText && typeof rule.selectorText === 'string') {
                const selectors = rule.selectorText.split(',');
                for (const sel of selectors) {
                  if (el.matches(sel.trim())) {
                    const display = rule.style.display;
                    if (display && display !== 'none') return display;
                  }
                }
              }
            }
          }
        } catch (e) {}
        return null;
      }

      function detectPresentationLibrary() {
        if (typeof window.Reveal !== 'undefined' && window.Reveal) return 'reveal';
        if (typeof window.impress !== 'undefined' && window.impress) return 'impress';
        if (typeof window.fullpage_api !== 'undefined' && window.fullpage_api) return 'fullpage';
        const swiperEl = document.querySelector('.swiper');
        if (swiperEl && typeof window.Swiper !== 'undefined' && window.Swiper) return 'swiper';
        return 'native';
      }

      function showSlide(index, selectors) {
        allSlides = selectors.map(path => {
          const matches = document.querySelectorAll('[' + marker + '="' + CSS.escape(path) + '"]');
          return matches.length === 1 ? matches[0] : null;
        });
        if (allSlides.length <= 1 || allSlides.some(el => !el) || !allSlides[index]) return;
        allSlides.forEach(getOriginalDisplay);
        const target = allSlides[index];
        const lib = detectPresentationLibrary();

        // 优先使用知名 PPT/幻灯片库的 API，避免直接覆盖 display 破坏动画/过渡
        if (lib === 'reveal' && typeof window.Reveal.slide === 'function') {
          try {
            const { h, v } = window.Reveal.getIndices(target);
            window.Reveal.slide(h, v);
            return;
          } catch (e) {}
        }

        if (lib === 'impress') {
          try {
            window.impress().goto(target);
            return;
          } catch (e) {}
        }

        if (lib === 'fullpage' && typeof window.fullpage_api.moveTo === 'function') {
          try {
            window.fullpage_api.moveTo(index + 1);
            return;
          } catch (e) {}
        }

        if (lib === 'swiper') {
          try {
            const swiperContainer = document.querySelector('.swiper');
            if (swiperContainer && swiperContainer.swiper && typeof swiperContainer.swiper.slideTo === 'function') {
              swiperContainer.swiper.slideTo(index);
              return;
            }
          } catch (e) {}
        }

        // 原生降级：识别并尊重页面自身的幻灯片显示约定
        // 常见的类驱动显示：.active / .current / .visible / .show / .selected
        const activeClass = detectActiveClassPattern();

        if (activeClass) {
          // 类驱动切换（如 SmartHybridDetectorV3_Defense.html 的 .active）
          allSlides.forEach((el, i) => {
            if (i === index) {
              el.classList.add(activeClass);
              // 清除可能由旧逻辑留下的内联 display，让 CSS 类生效
              el.style.display = '';
            } else {
              el.classList.remove(activeClass);
              el.style.display = '';
            }
          });
        } else {
          // display 驱动切换
          allSlides.forEach((el, i) => {
            if (i === index) {
              const original = getOriginalDisplay(el);
              if (!original || original === 'none') {
                el.style.display = inferDisplayType(el);
              } else {
                el.style.display = original;
              }
            } else {
              el.style.display = 'none';
            }
          });
        }

        // 确保 body 本身可见，但尽量不破坏原有 display 类型
        if (allSlides[0] !== document.body) {
          const bodyDisplay = window.getComputedStyle(document.body).display;
          if (bodyDisplay === 'none') {
            document.body.style.display = 'block';
          }
        }
        // 强制重排以确保样式变更生效
        document.body.offsetHeight;
      }

      function detectActiveClassPattern() {
        if (allSlides.length < 2) return null;
        const candidates = ['active', 'current', 'visible', 'show', 'selected'];
        for (const cls of candidates) {
          const count = allSlides.filter(el => el.classList.contains(cls)).length;
          // 有且仅有部分 slide 拥有该 class，才认为是激活标记
          if (count > 0 && count < allSlides.length) return cls;
        }
        return null;
      }

      window.addEventListener('message', function(e) {
        if (e.source === window.parent && e.data?.type === 'DECKFORGE_SHOW_PAGE') {
          showSlide(e.data.index, e.data.selectors);
        }
      });
    })();
  `;
  iframe.contentDocument.head.appendChild(script);
}

export function describeElement(el: HTMLElement, selector: string): SelectedElementInfo {
  return {
    selector, tagName: el.tagName, textContent: el.textContent || '',
    isTextEditable: isTextEditable(el), isImage: isImageElement(el),
    computedStyles: getComputedStyleMap(el), rect: el.getBoundingClientRect(),
  };
}

interface PreviewEvents {
  editing: () => boolean;
  select: (element: SelectedElementInfo | null) => void;
  commitText: (selector: string, html: string) => void;
  unavailable: () => void;
  shortcut: (event: KeyboardEvent) => void;
}

export function bindPreview(doc: Document, deck: DeckDocument, events: PreviewEvents) {
  const selected = deck.marker + '-selected';
  const editing = deck.marker + '-editing';
  const style = doc.createElement('style');
  style.textContent = `[${selected}]{outline:2px solid #7c3aed!important;outline-offset:2px}
    [${editing}]{user-select:text!important;pointer-events:auto!important}`;
  doc.head.appendChild(style);

  function targetOf(e: MouseEvent) {
    if (!events.editing()) return null;
    const el = e.target as HTMLElement;
    if (!el.tagName || el === doc.body || el === doc.documentElement || el.closest('[' + editing + ']')) return null;
    e.preventDefault();
    e.stopPropagation();
    const path = el.getAttribute(deck.marker);
    if (!path || deck.previewElement(path) !== el) {
      events.select(null);
      events.unavailable();
      return null;
    }
    return { el, path };
  }

  function click(e: MouseEvent) {
    const target = targetOf(e);
    if (target) events.select(describeElement(target.el, target.path));
  }

  function doubleClick(e: MouseEvent) {
    const target = targetOf(e);
    if (!target || !isTextEditable(target.el)) return;
    const { el, path } = target;
    // Flush a previous editor before reading the new baseline.
    (doc.activeElement as HTMLElement | null)?.blur();
    const before = el.innerHTML;
    const previousEditable = el.getAttribute('contenteditable');
    el.setAttribute(editing, '');
    el.contentEditable = 'true';
    el.addEventListener('blur', () => {
      if (previousEditable === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', previousEditable);
      el.removeAttribute(editing);
      if (el.innerHTML !== before) events.commitText(path, deck.editedContent(el));
    }, { once: true });
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    events.select(describeElement(el, path));
  }

  doc.addEventListener('click', click, true);
  doc.addEventListener('dblclick', doubleClick, true);
  doc.addEventListener('keydown', events.shortcut, true);
  return () => {
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('dblclick', doubleClick, true);
    doc.removeEventListener('keydown', events.shortcut, true);
  };
}

/**
 * 将 CSS/JS 内联到 HTML 中，生成单文件 HTML
 */
export function inlineResources(html: string, fileTree: { path: string; content?: string | ArrayBuffer }[]): string {
  let result = html;

  // 替换 <link rel="stylesheet" href="...">
  result = result.replace(
    /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (match, href) => {
      const file = fileTree.find((f) => f.path === href || f.path.endsWith(href));
      if (file && file.content && typeof file.content === 'string') {
        return `<style>${file.content}</style>`;
      }
      return match;
    }
  );

  // 替换 <script src="..."></script>
  result = result.replace(
    /<script[^>]*src=["']([^"']+)["'][^>]*>(?:<\/script>)?/gi,
    (match, src) => {
      const file = fileTree.find((f) => f.path === src || f.path.endsWith(src));
      if (file && file.content && typeof file.content === 'string') {
        return `<script>${file.content}</script>`;
      }
      return match;
    }
  );

  return result;
}
