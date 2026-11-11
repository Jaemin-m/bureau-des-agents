// 보고서 마크다운을 안전하게 보여 준다: 원본 HTML은 막고, 링크는 웹 주소만(새 탭으로 연다),
// 외부 이미지는 불러오지 않는다.
import { Marked } from 'marked';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const marked = new Marked({ breaks: true, gfm: true });
marked.use({
  renderer: {
    html: ({ text }) => escapeHtml(text ?? ''),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href ?? '')) return text;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ text }) { return escapeHtml(text ?? ''); },
  },
});

export function mdToHtml(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
